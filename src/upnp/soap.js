const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
});

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function sendSoapAction({ controlUrl, serviceType, action, params }) {
  const paramXml = Object.entries(params || {})
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('');

  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${paramXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

  try {
    console.log(`[SOAP] ${action} at ${controlUrl}`);
    console.log(`[SOAP] Service: ${serviceType}`);
    
    const response = await axios.post(controlUrl, body, {
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${serviceType}#${action}"`,
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      const errorMsg = response.data || `HTTP ${response.status}`;
      throw new Error(
        `Renderer returned error for ${action}: ${response.status}.\nResponse: ${errorMsg.substring(0, 500)}`,
      );
    }

    return parser.parse(response.data);
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      throw new Error(
        `Cannot reach renderer at ${controlUrl}. Check network connection and renderer availability.`,
      );
    }
    throw err;
  }
}

async function setAvTransportUri(renderer, mediaUrl, metadata = '') {
  console.log(`[SOAP_DEBUG] SetAVTransportURI - Media URL: ${mediaUrl}`);
  if (metadata) {
    console.log(`[SOAP_DEBUG] SetAVTransportURI - Metadata length: ${metadata.length} bytes`);
  } else {
    console.log(`[SOAP_DEBUG] SetAVTransportURI - No metadata`);
  }
  
  return sendSoapAction({
    controlUrl: renderer.services.avTransport.controlUrl,
    serviceType: renderer.services.avTransport.serviceType,
    action: 'SetAVTransportURI',
    params: {
      InstanceID: '0',
      CurrentURI: mediaUrl,
      CurrentURIMetaData: metadata ? xmlEscape(metadata) : '',
    },
  });
}

async function getTransportInfo(renderer) {
  try {
    const result = await sendSoapAction({
      controlUrl: renderer.services.avTransport.controlUrl,
      serviceType: renderer.services.avTransport.serviceType,
      action: 'GetTransportInfo',
      params: {
        InstanceID: '0',
      },
    });
    
    // Parse transport state from response
    const state = result?.['s:Envelope']?.['s:Body']?.['u:GetTransportInfoResponse']?.['CurrentTransportState'];
    if (state) {
      console.log(`[Transport] Current state: ${state}`);
    }
    
    return result;
  } catch (err) {
    console.warn(`[GetTransportInfo] Failed: ${err.message}`);
    return null;
  }
}

async function getCurrentTransportActions(renderer) {
  try {
    const result = await sendSoapAction({
      controlUrl: renderer.services.avTransport.controlUrl,
      serviceType: renderer.services.avTransport.serviceType,
      action: 'GetCurrentTransportActions',
      params: {
        InstanceID: '0',
      },
    });

    const actions = result?.['s:Envelope']?.['s:Body']?.['u:GetCurrentTransportActionsResponse']?.['Actions'] || '';
    if (actions) {
      console.log(`[Transport] Allowed actions: ${actions}`);
    } else {
      console.log('[Transport] Allowed actions: (empty)');
    }

    return result;
  } catch (err) {
    console.warn(`[GetCurrentTransportActions] Failed: ${err.message}`);
    return null;
  }
}

async function play(renderer, speed = '1') {
  try {
    console.log(`[SOAP_DEBUG] Sending Play action with Speed=${speed}`);
    return await sendSoapAction({
      controlUrl: renderer.services.avTransport.controlUrl,
      serviceType: renderer.services.avTransport.serviceType,
      action: 'Play',
      params: {
        InstanceID: '0',
        Speed: String(speed),
      },
    });
  } catch (err) {
    console.warn(`[Play] Warning: ${err.message}`);
    console.log(`[Play] Note: The TV may have already started playing after SetAVTransportURI.`);
    return null;
  }
}

async function pause(renderer) {
  return sendSoapAction({
    controlUrl: renderer.services.avTransport.controlUrl,
    serviceType: renderer.services.avTransport.serviceType,
    action: 'Pause',
    params: {
      InstanceID: '0',
    },
  });
}

async function stop(renderer) {
  return sendSoapAction({
    controlUrl: renderer.services.avTransport.controlUrl,
    serviceType: renderer.services.avTransport.serviceType,
    action: 'Stop',
    params: {
      InstanceID: '0',
    },
  });
}

async function setVolume(renderer, desiredVolume) {
  if (!renderer.services.renderingControl) {
    throw new Error('Renderer does not expose RenderingControl service');
  }

  return sendSoapAction({
    controlUrl: renderer.services.renderingControl.controlUrl,
    serviceType: renderer.services.renderingControl.serviceType,
    action: 'SetVolume',
    params: {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: String(desiredVolume),
    },
  });

}
module.exports = {
  setAvTransportUri,
  play,
  pause,
  stop,
  setVolume,
  getTransportInfo,
  getCurrentTransportActions,
};
