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

function getAllDevices(device) {
  if (!device) {
    return [];
  }

  const embeddedDevices = asArray(device?.deviceList?.device);
  return [
    device,
    ...embeddedDevices.flatMap((item) => getAllDevices(item)),
  ];
}

function findFirstDeviceWithService(rootDevice, serviceTypeNeedle) {
  const devices = getAllDevices(rootDevice);
  return devices.find((device) => findService(device, serviceTypeNeedle)) || null;
}

async function parseDeviceDescription(location, timeoutMs = 6000) {
  const response = await axios.get(location, { timeout: timeoutMs });
  const xml = parser.parse(response.data);
  const root = xml?.root;
  const rootDevice = root?.device;

  if (!rootDevice) {
    return null;
  }

  const avDevice = findFirstDeviceWithService(rootDevice, 'AVTransport');
  if (!avDevice) {
    return null;
  }

  const avTransport = findService(avDevice, 'AVTransport');
  if (!avTransport) {
    return null;
  }

  const renderingDevice = findFirstDeviceWithService(rootDevice, 'RenderingControl');
  const renderingControl = renderingDevice
    ? findService(renderingDevice, 'RenderingControl')
    : null;

  return {
    location,
    friendlyName: avDevice.friendlyName || rootDevice.friendlyName || 'Unknown Renderer',
    manufacturer: avDevice.manufacturer || rootDevice.manufacturer || '',
    modelName: avDevice.modelName || rootDevice.modelName || '',
    udn: avDevice.UDN || rootDevice.UDN || '',
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
    1291,
    1527,
  ].filter((value) => Number.isFinite(value) && value > 0)));

  const candidates = [];
  for (const candidatePort of ports) {
    candidates.push(
      `http://${targetIp}:${candidatePort}/description.xml`,
      `http://${targetIp}:${candidatePort}/DeviceDescription.xml`,
      `http://${targetIp}:${candidatePort}/dmr/description.xml`,
      `http://${targetIp}:${candidatePort}/ssdp/device-desc.xml`,
      `http://${targetIp}:${candidatePort}/`,
    );
  }

  const probed = await Promise.all(
    candidates.map(async (location) => {
      try {
        return await parseDeviceDescription(location, 2000);
      } catch {
        return null;
      }
    }),
  );

  for (const renderer of probed) {
    if (renderer?.services?.avTransport?.controlUrl) {
      return renderer;
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
