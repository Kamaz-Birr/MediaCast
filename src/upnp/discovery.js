import axios from 'axios';
import pkgSSDP from 'node-ssdp';
const { Client } = pkgSSDP;
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
});

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function toAbsoluteUrl(baseUrl, maybeRelative) {
  if (!maybeRelative) {
    return null;
  }

  try {
    return new URL(maybeRelative).toString();
  } catch {
    return new URL(maybeRelative, baseUrl).toString();
  }
}

function findService(device, serviceTypeNeedle) {
  const services = asArray(device?.serviceList?.service);
  return services.find((service) => String(service.serviceType || '').includes(serviceTypeNeedle));
}

async function parseDeviceDescription(location) {
  const response = await axios.get(location, { timeout: 6000 });
  const xml = parser.parse(response.data);
  const root = xml?.root;
  const device = root?.device;

  if (!device) {
    return null;
  }

  const avTransport = findService(device, 'AVTransport');
  if (!avTransport) {
    return null;
  }

  const renderingControl = findService(device, 'RenderingControl');

  return {
    location,
    friendlyName: device.friendlyName || 'Unknown Renderer',
    manufacturer: device.manufacturer || '',
    modelName: device.modelName || '',
    udn: device.UDN || '',
    services: {
      avTransport: {
        serviceType: avTransport.serviceType,
        controlUrl: toAbsoluteUrl(location, avTransport.controlURL),
      },
      renderingControl: renderingControl
        ? {
            serviceType: renderingControl.serviceType,
            controlUrl: toAbsoluteUrl(location, renderingControl.controlURL),
          }
        : null,
    },
  };
}

async function getRendererByIp(ip, port = 1029) {
  const targetIp = String(ip || '').trim();
  if (!targetIp) {
    return null;
  }

  // First pass: use SSDP discovery and match by advertised location host.
  try {
    const discovered = await discoverRenderers(3500);
    const matched = discovered.find((renderer) => {
      try {
        return new URL(renderer.location).hostname === targetIp;
      } catch {
        return false;
      }
    });

    if (matched?.services?.avTransport?.controlUrl) {
      return matched;
    }
  } catch {
    // Continue to direct HTTP probing fallback.
  }

  // Fallback: probe common description endpoints across likely ports.
  const ports = Array.from(new Set([
    Number(port),
    80,
    1400,
    1029,
    1527,
  ].filter((value) => Number.isFinite(value) && value > 0)));

  const candidates = [];
  for (const candidatePort of ports) {
    candidates.push(
      `http://${targetIp}:${candidatePort}/description.xml`,
      `http://${targetIp}:${candidatePort}/DeviceDescription.xml`,
      `http://${targetIp}:${candidatePort}/dmr/description.xml`,
      `http://${targetIp}:${candidatePort}/`,
    );
  }

  for (const location of candidates) {
    try {
      const renderer = await parseDeviceDescription(location);
      if (renderer?.services?.avTransport?.controlUrl) {
        return renderer;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function discoverRenderers(timeoutMs = 5000) {
  const client = new Client({ explicitSocketBind: true });
  const locations = new Set();

  client.on('response', (headers) => {
    const location = headers.LOCATION || headers.Location || headers.location;
    if (location) {
      locations.add(location);
    }
  });

  client.search('urn:schemas-upnp-org:device:MediaRenderer:1');
  client.search('urn:schemas-upnp-org:device:MediaRenderer:2');

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  client.stop();

  const renderers = [];
  for (const location of locations) {
    try {
      const device = await parseDeviceDescription(location);
      if (device?.services?.avTransport?.controlUrl) {
        renderers.push(device);
      }
    } catch {
      continue;
    }
  }

  const deduped = new Map();
  for (const renderer of renderers) {
    const key = renderer.udn || renderer.location;
    if (!deduped.has(key)) {
      deduped.set(key, renderer);
    }
  }

  return [...deduped.values()];
}

function pickRenderer(renderers, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) {
    return renderers[0] || null;
  }

  return (
    renderers.find((renderer) => String(renderer.udn).toLowerCase() === needle) ||
    renderers.find((renderer) => String(renderer.friendlyName).toLowerCase() === needle) ||
    renderers.find((renderer) => String(renderer.friendlyName).toLowerCase().includes(needle)) ||
    null
  );
}

export {
  discoverRenderers,
  pickRenderer,
  getRendererByIp,
};
