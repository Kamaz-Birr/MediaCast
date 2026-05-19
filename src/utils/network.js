import os from 'os';

export function getLocalIPv4() {
  const interfaces = os.networkInterfaces();

  // Prefer non-virtual adapters
  const preferredNames = ['eth0', 'en0', 'en1', 'wlan0', 'Ethernet', 'WiFi'];
  for (const name of preferredNames) {
    const iface = interfaces[name];
    if (iface) {
      for (const address of iface) {
        if (address.family === 'IPv4' && !address.internal) {
          return address.address;
        }
      }
    }
  }

  // Fall back to any non-loopback IPv4 address
  for (const iface of Object.values(interfaces)) {
    for (const address of iface || []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return '127.0.0.1';
}

export function getLocalIPForRenderer(rendererIp) {
  if (!rendererIp || rendererIp === 'localhost' || rendererIp === '127.0.0.1') {
    return null;
  }

  const interfaces = os.networkInterfaces();
  const rendererOctets = rendererIp.split('.');
  if (rendererOctets.length !== 4) {
    return null;
  }

  const rendererSubnet = rendererOctets.slice(0, 3).join('.');

  // Find a local IP on the same subnet as the renderer
  for (const iface of Object.values(interfaces)) {
    for (const address of iface || []) {
      if (address.family === 'IPv4' && !address.internal) {
        const localOctets = address.address.split('.');
        const localSubnet = localOctets.slice(0, 3).join('.');
        if (localSubnet === rendererSubnet) {
          return address.address;
        }
      }
    }
  }

  return null;
}

