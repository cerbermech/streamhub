"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { countViewers } = require("../src/viewer-count.cjs");
const id = "11111111-1111-1111-1111-111111111111";
const slug = "kanal-1";

test("counts an RTSP client, ignores the alias' internal pull and counts HLS", () => {
  const paths = new Map([
    [slug, [{ type: "rtspSession", id: "vlc" }]],
    [`channel-${id}`, [
      { type: "rtspSession", id: "internal-pull" },
      { type: "hlsSession", id: "browser" },
    ]],
  ]);
  assert.equal(countViewers(paths, id, slug), 2);
  paths.set(slug, []);
  assert.equal(countViewers(paths, id, slug), 1);
  paths.set(`channel-${id}`, [{ type: "rtspSession", id: "internal-pull" }]);
  assert.equal(countViewers(paths, id, slug), 0);
});

test("does not count publishers, hidden readers or the same reader twice", () => {
  const paths = new Map([
    [slug, [{ type: "hlsSession", id: "same" }, { type: "hidden", id: "hidden" }]],
    [`channel-${id}`, [{ type: "hlsSession", id: "same" }]],
  ]);
  assert.equal(countViewers(paths, id, slug), 1);
});
