import { getDlnaProtocolInfo, mediaKind } from '../utils/media.js';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildDidlLite({ title, filePath, mediaUrl, subtitleUrl }) {
  if (!mediaUrl || typeof mediaUrl !== 'string') {
    throw new Error('mediaUrl is required and must be a string');
  }

  const protocolInfo = getDlnaProtocolInfo(filePath);
  const kind = mediaKind(filePath);
  const upnpClass = kind === 'audio' ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem.movie';

  const safeName = escapeXml(title || 'Unknown Media');
  const safeMimeType = escapeXml(protocolInfo);
  const safeUrl = escapeXml(mediaUrl);
  const safeSubtitleUrl = subtitleUrl ? escapeXml(subtitleUrl) : null;

  const subtitleNode = safeSubtitleUrl
    ? `
    <sec:CaptionInfoEx sec:type="srt">${safeSubtitleUrl}</sec:CaptionInfoEx>
    <res protocolInfo="http-get:*:application/x-subrip:*">${safeSubtitleUrl}</res>`
    : '';

  console.log(`[Metadata] Title: ${title}, ProtocolInfo: ${protocolInfo}, MediaURL: ${mediaUrl}`);
  if (subtitleUrl) {
    console.log(`[Metadata] Subtitle URL: ${subtitleUrl}`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"
           xmlns:sec="http://www.sec.co.kr/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>${safeName}</dc:title>
    <upnp:class>${upnpClass}</upnp:class>
    <res protocolInfo="${safeMimeType}">${safeUrl}</res>
${subtitleNode}
  </item>
</DIDL-Lite>`;
}

