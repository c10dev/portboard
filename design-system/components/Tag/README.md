# Tag

A small inline pill that adds a short status after a service, guest or port name.

## When to use

- Use it to mark a short fact about the name before it: "serve", "this server", "Tailscale off", "via laptop", "tailnet".
- Keep the text to one to three words.
- Do not use it as a button or a link. It has no hover or focus state.
- Do not use it for a full status line or a count. Use the row's meta text for those.

## Markup

The consumer supplies a `span` with the `tag` class, placed inside the name element of the row.

```html
<span class="use-name"><span>my-app</span><span class="use-port">:5173</span><span class="tag serve">serve</span></span>

<button class="guest-name" type="button">
  <span class="gtype lxc">CT</span><span class="vmid">101</span><span class="gname">api</span>
  <span class="tag">this server</span>
</button>

<div class="d-use-h"><strong>api</strong><span class="use-port">:8080</span><span class="tag">via laptop</span></div>

<ul class="hports">
  <li><span class="hp-name"><span class="hp-port">:3000</span><span class="hp-proc">node</span><span class="tag info">tailnet</span></span></li>
</ul>
```

The tag needs no wrapper of its own. The parent element sets the gap and the alignment: baseline in `.use-name`, `.d-use-h` and `.hp-name`, centre in `.guest-name`.

## Variants

- `.tag`: neutral pill. Muted text on a neutral background. Use it for plain facts such as "this server" or "via laptop".
- `.tag.serve`: purple pill. It marks a use that arrives through Tailscale Serve. The purple is a literal colour, not a token, and it changes to a lighter purple in the dark theme.
- `.tag.warn`: warning pill. It marks a running guest whose Tailscale is off. In a port list it marks a port that listens on that device only.
- `.tag.info`: info pill. It works only inside `ul.hports`. It marks a port that the tailnet or the LAN can reach. Outside `.hports` it falls back to the neutral pill.

## Tokens

- the `neutral-bg` token: background of the neutral tag.
- the `muted` token: text of the neutral tag.
- the `surface` token: the base that the serve purple mixes into.
- the `warn` token and the `warn-bg` token: text and background of the warning tag.
- the `info` token and the `info-bg` token: text and background of the info tag in a port list.

## Do and don't

- Do put the tag after the name and the port, not before them.
- Do take the text from the i18n files. Only fixed names such as "serve", "WSL", "Windows", "tailnet" and "LAN" stay literal.
- Don't add a new colour by hand. Add a variant class that uses a token.
- Do set a `title` when the short text needs an explanation, as the routed "via" tag does.

Static rendition hand-written from public/devices.css:52-53, 86, 127-131, public/style.css:273-275 and public/features/usage.js:useList, public/features/proxmox.js:guestList, public/devices.js:paintDetail, public/features/host-ports.js:portList.
