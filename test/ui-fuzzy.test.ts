// The command palette's matcher (public/lib/fuzzy.js) and its pure helpers (public/lib/palette.js), run in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, initialOf, matchWord, rank, score, segments, words } from '../public/lib/fuzzy.js';
import { verbSplit } from '../public/lib/palette.js';

test('fold and words: lower case, NFC, split on spaces', () => {
  assert.equal(fold('PortBoard'), 'portboard');
  assert.equal(fold('한'.normalize('NFD')), '한');
  assert.equal(fold(null), '');
  assert.deepEqual(words('  8790  Logs '), ['8790', 'logs']);
  assert.deepEqual(words(''), []);
});

test('initialOf: the first consonant of a Hangul syllable', () => {
  assert.equal(initialOf('포'), 'ㅍ');
  assert.equal(initialOf('가'), 'ㄱ');
  assert.equal(initialOf('힣'), 'ㅎ');
  assert.equal(initialOf('a'), null);
  assert.equal(initialOf('ㅍ'), null);
});

test('matchWord: runs beat scattered matches, the start and word starts beat the middle', () => {
  const start = matchWord('port', 'portboard')!;
  const word = matchWord('board', 'port board')!;
  const mid = matchWord('oar', 'portboard')!;
  const scattered = matchWord('pbd', 'portboard')!;
  assert.deepEqual(start.hits, [0, 1, 2, 3]);
  assert.deepEqual(word.hits, [5, 6, 7, 8, 9]);
  assert.ok(start.score > word.score && word.score > mid.score && mid.score > scattered.score, JSON.stringify([start, word, mid, scattered]));
  assert.deepEqual(scattered.hits, [0, 4, 8]);
  assert.equal(matchWord('xyz', 'portboard'), null);
  assert.equal(matchWord('dp', 'portboard'), null, 'order matters');
});

test('matchWord: the whole text scores more than a prefix of it, ports by number', () => {
  assert.ok(matchWord('8790', '8790')!.score > matchWord('8790', '87901')!.score);
  assert.ok(matchWord('87', '8790 portboard')!.score > matchWord('87', '3087')!.score);
  assert.equal(matchWord('8790', '8794 portboard-remote :8794 pid 1200'), null, 'digits never match scattered');
});

test('matchWord: Hangul initial consonants match syllables, mixed with full syllables', () => {
  assert.deepEqual(matchWord('ㅍㅌ', '포트 목록')!.hits, [0, 1]);
  assert.deepEqual(matchWord('ㄱㄱ', '기기 탭')!.hits, [0, 1]);
  assert.deepEqual(matchWord('서ㅂ', '서비스')!.hits, [0, 1]);
  assert.equal(matchWord('ㅎ', '서비스'), null);
});

test('score: every word must match; the title counts more than the other text and gives the hits', () => {
  assert.equal(score('8790 nope', '8790 portboard', 'portboard.service'), null);
  const both = score('8790 service', '8790 portboard', 'portboard.service')!;
  assert.deepEqual(both.hits, [0, 1, 2, 3], 'only title matches are highlighted');
  const inTitle = score('portboard', 'portboard', '')!;
  const inText = score('portboard', '8790', 'portboard')!;
  assert.ok(inTitle.score > inText.score);
  assert.deepEqual(score('', 'anything'), { score: 0, hits: [] });
});

test('rank: best first, ties in input order, boost for recent items, blank query keeps order, limit', () => {
  const items = [
    { title: '3000 webapp', text: '~/projects/webapp' },
    { title: '8790 portboard', text: 'portboard.service' },
    { title: '8791 portboard-preview', text: '' },
    { title: '기기 탭', text: 'devices' },
  ];
  assert.deepEqual(rank('', items).map((r) => r.item), items);
  assert.deepEqual(rank('portboard', items).map((r) => r.item.title), ['8790 portboard', '8791 portboard-preview']);
  assert.deepEqual(rank('portboard', [items[2], { title: '8792 portboard-x' }]).map((r) => r.item.title), ['8791 portboard-preview', '8792 portboard-x'], 'a tie keeps the input order');
  const boosted = rank('portboard', [items[1], { ...items[2], boost: 200 }]);
  assert.equal(boosted[0].item.title, '8791 portboard-preview');
  assert.equal(rank('', [{ title: 'a', boost: 99 }, { title: 'b' }])[0].item.title, 'a');
  assert.deepEqual(rank('ㄱㄱ', items).map((r) => r.item.title), ['기기 탭']);
  assert.equal(rank('o', items, { limit: 2 }).length, 2);
});

test('segments: runs of matched and unmatched characters', () => {
  assert.deepEqual(segments('8790 portboard', [0, 1, 5]), [{ text: '87', hit: true }, { text: '90 ', hit: false }, { text: 'p', hit: true }, { text: 'ortboard', hit: false }]);
  assert.deepEqual(segments('', []), []);
});

test('verbSplit: a word that starts an action name picks that action; the other words search the items', () => {
  const verbs = [
    { key: 'logs', names: ['로그', 'logs'] },
    { key: 'restart', names: ['재시작', 'restart'] },
    { key: 'stop', names: ['중지', 'stop'] },
  ];
  assert.deepEqual(verbSplit('8790 로그', verbs), { verb: 'logs', rest: '8790' });
  assert.deepEqual(verbSplit('restart webapp', verbs), { verb: 'restart', rest: 'webapp' });
  assert.deepEqual(verbSplit('재시', verbs), { verb: 'restart', rest: '' });
  assert.deepEqual(verbSplit('s portboard', verbs), null, 'one Latin letter is too short to be a verb');
  assert.deepEqual(verbSplit('portboard', verbs), null);
  assert.deepEqual(verbSplit('', verbs), null);
});
