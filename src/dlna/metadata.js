const { getDlnaProtocolInfo, mediaKind } = require('../utils/media');

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDidlLite({ title, filePath, mediaUrl }) {
  if (!mediaUrl || typeof mediaUrl !== 'string') {
    throw new Error('mediaUrl is required and must be a string');
  }

  const protocolInfo = getDlnaProtocolInfo(filePath);
  const kind = mediaKind(filePath);
  const upnpClass = kind === 'audio' ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem.movie';

  const safeName = escapeXml(title || 'Unknown Media');
  const safeMimeType = escapeXml(protocolInfo);
  const safeUrl = escapeXml(mediaUrl);

  return `<?xml version="1.0" encoding="UTF-8"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>${safeName}</dc:title>
    <upnp:class>${upnpClass}</upnp:class>
    <res protocolInfo="${safeMimeType}">${safeUrl}</res>
  </item>
</DIDL-Lite>`;
}

module.exports = {
  buildDidlLite,
};
