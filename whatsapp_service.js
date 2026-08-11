/**
 * whatsapp_service.js — WhatsApp Business API Service (360dialog / Meta)
 */

const db = require('./database');

// URL base de 360dialog API (v2 — Cloud API)
function getApiUrl(apiKey) {
  if (apiKey && apiKey.includes('SBN')) {
    return 'https://waba-sandbox.360dialog.io/v1/messages';
  }
  return 'https://waba-v2.360dialog.io/messages';
}

/**
 * Obtiene la configuración actual de la API de WhatsApp de la BD
 */
function getConfig() {
  try {
    let cfg = db.prepare('SELECT * FROM config_whatsapp_api WHERE id = 1').get();
    if (!cfg) {
      db.prepare("INSERT INTO config_whatsapp_api (id, proveedor, modo) VALUES (1, '360dialog', 'simulacion')").run();
      cfg = db.prepare('SELECT * FROM config_whatsapp_api WHERE id = 1').get();
    }
    return cfg;
  } catch (err) {
    console.error('[WA Service] Error leyendo config:', err);
    return { modo: 'simulacion', api_key: '', proveedor: '360dialog' };
  }
}

/**
 * Guarda la configuración de la API (API Key, modo, etc.)
 */
function saveConfig({ proveedor, api_key, waba_id, phone_number_id, modo, webhook_url }) {
  try {
    db.prepare(`
      INSERT INTO config_whatsapp_api (id, proveedor, api_key, waba_id, phone_number_id, modo, webhook_url, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        proveedor = excluded.proveedor,
        api_key = excluded.api_key,
        waba_id = excluded.waba_id,
        phone_number_id = excluded.phone_number_id,
        modo = excluded.modo,
        webhook_url = excluded.webhook_url,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      proveedor || '360dialog',
      api_key || '',
      waba_id || '',
      phone_number_id || '',
      modo || 'simulacion',
      webhook_url || ''
    );
    return { ok: true };
  } catch (err) {
    console.error('[WA Service] Error guardando config:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Formatea un número de teléfono a formato E.164 sin '+' (ej: '5492235998888')
 */
function formatPhone(phone) {
  if (!phone) return '';
  let str = String(phone).replace(/[^\d]/g, '');
  if (!str) return '';
  if (str.startsWith('549')) return str;
  if (str.startsWith('54') && !str.startsWith('549')) return '549' + str.substring(2);
  if (str.startsWith('223')) return '549' + str;
  return str.startsWith('54') ? str : '54' + str;
}

/**
 * Envía un mensaje de texto libre a través de 360dialog API (dentro de ventana de 24hs)
 */
async function sendTextMessage(clienteId, phone, text) {
  const cfg = getConfig();
  const formattedPhone = formatPhone(phone);

  if (cfg.modo === 'simulacion' || !cfg.api_key) {
    console.log(`[WA Simulación] Mensaje a ${formattedPhone}: "${text}"`);
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado)
      VALUES (?, 'saliente', ?, ?, 'texto', 'enviado')
    `).run(clienteId, formattedPhone, text);
    return { ok: true, simulado: true, id: res.lastInsertRowid };
  }

  // Modo oficial via 360dialog API
  try {
    const response = await fetch(getApiUrl(cfg.api_key), {
      method: 'POST',
      headers: {
        'D360-API-KEY': cfg.api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: formattedPhone,
        type: 'text',
        text: { body: text }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[WA API Error]', data);
      db.prepare(`
        INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, meta_data)
        VALUES (?, 'saliente', ?, ?, 'texto', 'fallido', ?)
      `).run(clienteId, formattedPhone, text, JSON.stringify(data));
      return { ok: false, error: data.error || 'Error al enviar por 360dialog' };
    }

    const waMsgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data)
      VALUES (?, ?, 'saliente', ?, ?, 'texto', 'enviado', ?)
    `).run(clienteId, waMsgId, formattedPhone, text, JSON.stringify(data));

    return { ok: true, wa_message_id: waMsgId, id: res.lastInsertRowid };
  } catch (err) {
    console.error('[WA Service Exception]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía una plantilla pre-aprobada de WhatsApp
 */
async function sendTemplateMessage(clienteId, phone, templateName, languageCode = 'es', parameters = []) {
  const cfg = getConfig();
  const formattedPhone = formatPhone(phone);

  if (cfg.modo === 'simulacion' || !cfg.api_key) {
    console.log(`[WA Simulación Plantilla] ${templateName} a ${formattedPhone}`);
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado)
      VALUES (?, 'saliente', ?, ?, 'plantilla', 'enviado')
    `).run(clienteId, formattedPhone, `[Plantilla: ${templateName}]`);
    return { ok: true, simulado: true, id: res.lastInsertRowid };
  }

  try {
    const components = parameters.length > 0 ? [
      {
        type: 'body',
        parameters: parameters.map(p => ({ type: 'text', text: String(p) }))
      }
    ] : [];

    const payload = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components
      }
    };

    console.log('[360dialog Outbound HSM Payload]', JSON.stringify(payload, null, 2));

    const response = await fetch(getApiUrl(cfg.api_key), {
      method: 'POST',
      headers: {
        'D360-API-KEY': cfg.api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('[360dialog Response]', JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error('[WA API Template Error]', data);
      db.prepare(`
        INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, meta_data)
        VALUES (?, 'saliente', ?, ?, 'plantilla', 'fallido', ?)
      `).run(clienteId, formattedPhone, `[Plantilla: ${templateName}]`, JSON.stringify(data));
      return { ok: false, error: data.meta?.developer_message || data.error?.message || data.error || 'Error al enviar plantilla' };
    }

    const waMsgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data)
      VALUES (?, ?, 'saliente', ?, ?, 'plantilla', 'enviado', ?)
    `).run(clienteId, waMsgId, formattedPhone, `[Plantilla: ${templateName}]`, JSON.stringify(data));

    return { ok: true, wa_message_id: waMsgId, id: res.lastInsertRowid };
  } catch (err) {
    console.error('[WA Template Exception]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Procesa webhooks entrantes de Meta / 360dialog (Mensajes entrantes y estados de entrega)
 */
function processWebhookPayload(payload) {
  try {
    const entry = payload.entry && payload.entry[0];
    const changes = entry && entry.changes && entry.changes[0];
    const value = changes && changes.value;

    if (!value) return { ok: true, processed: false };

    // 1. Procesar Estados de Entrega (enviado -> entregado -> leido -> fallido)
    if (value.statuses && value.statuses.length > 0) {
      value.statuses.forEach(status => {
        const waMsgId = status.id;
        const newStatus = status.status; // 'sent', 'delivered', 'read', 'failed'
        const estadoMapeado = newStatus === 'sent' ? 'enviado'
                            : newStatus === 'delivered' ? 'entregado'
                            : newStatus === 'read' ? 'leido'
                            : newStatus === 'failed' ? 'fallido' : newStatus;

        db.prepare(`
          UPDATE mensajes_whatsapp
          SET estado = ?
          WHERE wa_message_id = ?
        `).run(estadoMapeado, waMsgId);
      });
    }

    // 2. Procesar Mensajes Entrantes de Clientes
    if (value.messages && value.messages.length > 0) {
      value.messages.forEach(msg => {
        const fromPhone = formatPhone(msg.from);
        const waMsgId = msg.id;
        let textContent = '';

        if (msg.type === 'text' && msg.text) {
          textContent = msg.text.body;
        } else if (msg.type === 'image' && msg.image) {
          const caption = msg.image.caption ? ` ${msg.image.caption}` : '';
          const mediaId = msg.image.id || '';
          textContent = `📷 [Imagen recibida:${mediaId}]${caption}`;
        } else if (msg.type === 'document' && msg.document) {
          const mediaId = msg.document.id || '';
          const fileName = msg.document.filename || 'Comprobante.pdf';
          textContent = `📄 [Documento:${mediaId}:${fileName}]`;
        } else {
          textContent = `[Mensaje tipo: ${msg.type}]`;
        }

        // Buscar cliente por teléfono
        const cliente = db.prepare(`
          SELECT id FROM clientes 
          WHERE replace(replace(replace(telefono, ' ', ''), '+', ''), '-', '') LIKE ?
          LIMIT 1
        `).get(`%${fromPhone.slice(-8)}%`);

        const clienteId = cliente ? cliente.id : null;

        db.prepare(`
          INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data)
          VALUES (?, ?, 'entrante', ?, ?, ?, 'recibido', ?)
        `).run(clienteId, waMsgId, fromPhone, textContent, msg.type || 'texto', JSON.stringify(msg));

        console.log(`[WA Entrante] De ${fromPhone} (Cliente ${clienteId || 'Desconocido'}): "${textContent}"`);
      });
    }

    return { ok: true, processed: true };
  } catch (err) {
    console.error('[WA Webhook Error]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Obtiene el historial de chat con un cliente
 */
function getChatHistory(clienteId) {
  try {
    const list = db.prepare(`
      SELECT m.*, c.nombre as cliente_nombre
      FROM mensajes_whatsapp m
      LEFT JOIN clientes c ON m.cliente_id = c.id
      WHERE m.cliente_id = ?
      ORDER BY m.created_at ASC
    `).all(clienteId);
    return list;
  } catch (err) {
    console.error('[WA Chat History Error]', err);
    return [];
  }
}

/**
 * Obtiene la lista de chats/conversaciones recientes para la Bandeja de Entrada
 */
function getConversacionesBandeja() {
  try {
    const list = db.prepare(`
      SELECT 
        m.cliente_id,
        c.nombre as cliente_nombre,
        c.telefono as cliente_telefono,
        m.mensaje as ultimo_mensaje,
        m.direccion as ultima_direccion,
        m.estado as ultimo_estado,
        m.created_at as ultima_fecha,
        (
          SELECT COUNT(*) 
          FROM mensajes_whatsapp m2 
          WHERE m2.cliente_id = m.cliente_id AND m2.direccion = 'entrante' AND m2.estado = 'recibido'
        ) as sin_leer
      FROM mensajes_whatsapp m
      JOIN clientes c ON m.cliente_id = c.id
      WHERE m.id IN (
        SELECT MAX(id) FROM mensajes_whatsapp GROUP BY cliente_id
      )
      ORDER BY m.created_at DESC
    `).all();
    return list;
  } catch (err) {
    console.error('[WA Bandeja Error]', err);
    return [];
  }
}

/**
 * Envía un archivo multimedia (PDF, imagen, etc.) por WhatsApp
 */
async function sendMediaMessage(clienteId, phone, fileUrl, fileName, mimeType = 'application/pdf') {
  const cfg = getConfig();
  const formattedPhone = formatPhone(phone);

  if (cfg.modo === 'simulacion' || !cfg.api_key) {
    console.log(`[WA Simulación Archivo] ${fileName} (${fileUrl}) a ${formattedPhone}`);
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado)
      VALUES (?, 'saliente', ?, ?, 'archivo', 'enviado')
    `).run(clienteId, formattedPhone, `📎 [Archivo: ${fileName}] (${fileUrl})`);
    return { ok: true, simulado: true, id: res.lastInsertRowid };
  }

  try {
    const isImage = mimeType.startsWith('image/');
    const mediaType = isImage ? 'image' : 'document';
    const mediaPayload = isImage 
      ? { link: fileUrl, caption: fileName }
      : { link: fileUrl, filename: fileName };

    const response = await fetch(getApiUrl(cfg.api_key), {
      method: 'POST',
      headers: {
        'D360-API-KEY': cfg.api_key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: formattedPhone,
        type: mediaType,
        [mediaType]: mediaPayload
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[WA API Media Error]', data);
      return { ok: false, error: data.error || 'Error al enviar archivo por 360dialog' };
    }

    const waMsgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data)
      VALUES (?, ?, 'saliente', ?, ?, 'archivo', 'enviado', ?)
    `).run(clienteId, waMsgId, formattedPhone, `📎 ${fileName} (${fileUrl})`, JSON.stringify(data));

    return { ok: true, wa_message_id: waMsgId, id: res.lastInsertRowid };
  } catch (err) {
    console.error('[WA Service Media Exception]', err);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getConfig,
  saveConfig,
  formatPhone,
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  processWebhookPayload,
  getChatHistory,
  getConversacionesBandeja
};
