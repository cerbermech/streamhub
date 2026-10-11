"use strict";

// MediaMTX exposes readers on both the public alias and the internal stream.
// The alias's RTSP pull from the internal stream is an implementation detail.
function countViewers(paths, channelId, slug) {
  const counted = new Set();
  const add = (path, allowed) => {
    for (const [index, reader] of (paths.get(path) || []).entries()) {
      if (!reader || !allowed(reader.type) || reader.type === "hidden") continue;
      counted.add(reader.id ? `${reader.type}:${reader.id}` : `${path}:${index}`);
    }
  };
  add(slug, () => true);
  add(`channel-${channelId}`, (type) => type === "hlsSession");
  return counted.size;
}

module.exports = { countViewers };
