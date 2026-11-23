package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const defaultURL = "http://127.0.0.1:8790"

// baseURL is PORTBOARD_URL without trailing slashes, or the default.
func baseURL() string {
	b := os.Getenv("PORTBOARD_URL")
	if b == "" {
		b = defaultURL
	}
	return strings.TrimRight(b, "/")
}

// parseHTTP parses a base URL. ok is false when it does not parse or its scheme is not http or https.
func parseHTTP(base string) (u *url.URL, ok bool) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, false
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, false
	}
	return u, true
}

// outcome of one request. kind is "reply" (a status and body arrived), "connect" (nothing was sent: no connection)
// or "lost" (the request may have been sent, and no reply arrived). why is the tail of a "lost": "lost" or "timeout".
type outcome struct {
	kind   string
	status int
	body   []byte
	why    string
}

type reqOpts struct {
	connectTimeout time.Duration // 0: none
	total          time.Duration // 0: none; covers connect, headers and body
	reply          time.Duration // 0: none; starts when the connection is made
	readLimit      int64         // bytes of the body to read
}

// do sends one request on a new connection. No proxy from the environment, no keep-alive (a reused connection could
// fail after sending and be sent again behind the caller's back). A connection that was made marks the request as
// possibly sent, as the socket's connect event does in thin.mjs.
func do(method, rawURL string, headers map[string]string, body []byte, o reqOpts) outcome {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var connected, timedOut atomic.Bool
	var replyTimer atomic.Pointer[time.Timer]
	expire := func() {
		timedOut.Store(true)
		cancel()
	}
	if o.total > 0 {
		t := time.AfterFunc(o.total, expire)
		defer t.Stop()
	}
	defer func() {
		if t := replyTimer.Load(); t != nil {
			t.Stop()
		}
	}()
	tr := &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := (&net.Dialer{Timeout: o.connectTimeout}).DialContext(ctx, network, addr)
			if err == nil {
				connected.Store(true)
				if o.reply > 0 {
					replyTimer.Store(time.AfterFunc(o.reply, expire))
				}
			}
			return c, err
		},
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr}
	// Redirects are never followed: a 3xx is the answer. The request goes only to the address that was configured.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, rd)
	if err != nil {
		return outcome{kind: "connect"}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	lost := func() outcome {
		if !connected.Load() {
			return outcome{kind: "connect"}
		}
		if timedOut.Load() {
			return outcome{kind: "lost", why: "timeout"}
		}
		return outcome{kind: "lost", why: "lost"}
	}
	res, err := client.Do(req)
	if err != nil {
		return lost()
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, o.readLimit))
	if err != nil {
		return lost()
	}
	return outcome{kind: "reply", status: res.StatusCode, body: data}
}
