const os = require('os');

function getLocalIPv4() {
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

module.exports = {
  getLocalIPv4,
};
