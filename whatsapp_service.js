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
 * Defaults: Modo Oficial API con key de producción de 360dialog
 */
const WA_DEFAULT_API_KEY = process.env.D360_API_KEY || 'tu8gwTxn2pDWW71EWJXVElDfAK';
const WA_DEFAULT_MODO = 'oficial';
const WA_DEFAULT_WEBHOOK = 'https://segucar-kuu2.onrender.com/api/webhooks/whatsapp';
const WA_DEFAULT_N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || '';

function getConfig() {
  try {
    // Siempre garantizar que la config de producción esté cargada correctamente
    // (Render puede recrear la DB en cada redeploy con valores vacíos o de simulación)
    db.prepare(`
      INSERT INTO config_whatsapp_api (id, proveedor, api_key, modo, webhook_url, n8n_webhook_url)
      VALUES (1, '360dialog', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        modo = CASE WHEN modo IS NULL OR modo = '' OR modo = 'simulacion' THEN excluded.modo ELSE modo END,
        api_key = CASE WHEN api_key IS NULL OR api_key = '' THEN excluded.api_key ELSE api_key END,
        proveedor = '360dialog',
        webhook_url = CASE WHEN webhook_url IS NULL OR webhook_url = '' THEN excluded.webhook_url ELSE webhook_url END,
        n8n_webhook_url = CASE WHEN (n8n_webhook_url IS NULL OR n8n_webhook_url = '') AND excluded.n8n_webhook_url != '' THEN excluded.n8n_webhook_url ELSE n8n_webhook_url END
    `).run(WA_DEFAULT_API_KEY, WA_DEFAULT_MODO, WA_DEFAULT_WEBHOOK, WA_DEFAULT_N8N_WEBHOOK);

    const cfg = db.prepare('SELECT * FROM config_whatsapp_api WHERE id = 1').get();
    return cfg;
  } catch (err) {
    console.error('[WA Service] Error leyendo config:', err);
    return { modo: WA_DEFAULT_MODO, api_key: WA_DEFAULT_API_KEY, proveedor: '360dialog', n8n_webhook_url: WA_DEFAULT_N8N_WEBHOOK };
  }
}

/**
 * Guarda la configuración de la API (API Key, modo, n8n webhook, etc.)
 */
function saveConfig({ proveedor, api_key, waba_id, phone_number_id, modo, webhook_url, n8n_webhook_url }) {
  try {
    const existing = db.prepare('SELECT * FROM config_whatsapp_api WHERE id = 1').get() || {};
    db.prepare(`
      INSERT INTO config_whatsapp_api (id, proveedor, api_key, waba_id, phone_number_id, modo, webhook_url, n8n_webhook_url, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        proveedor = COALESCE(excluded.proveedor, proveedor),
        api_key = COALESCE(excluded.api_key, api_key),
        waba_id = COALESCE(excluded.waba_id, waba_id),
        phone_number_id = COALESCE(excluded.phone_number_id, phone_number_id),
        modo = COALESCE(excluded.modo, modo),
        webhook_url = COALESCE(excluded.webhook_url, webhook_url),
        n8n_webhook_url = COALESCE(excluded.n8n_webhook_url, n8n_webhook_url),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      proveedor || existing.proveedor || '360dialog',
      api_key !== undefined ? api_key : (existing.api_key || ''),
      waba_id !== undefined ? waba_id : (existing.waba_id || ''),
      phone_number_id !== undefined ? phone_number_id : (existing.phone_number_id || ''),
      modo || existing.modo || 'simulacion',
      webhook_url !== undefined ? webhook_url : (existing.webhook_url || ''),
      n8n_webhook_url !== undefined ? n8n_webhook_url : (existing.n8n_webhook_url || '')
    );
    return { ok: true };
  } catch (err) {
    console.error('[WA Service] Error guardando config:', err);
    return { ok: false, error: err.message };
  }
}

const WA_DEFAULT_N8N_API_KEY = process.env.N8N_WEBHOOK_API_KEY || 'segucar_fase01_wa_inbound_sec_2026';

function resolveValidClienteId(clienteId) {
  if (!clienteId) return null;
  try {
    const row = db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId);
    return row ? row.id : null;
  } catch (e) {
    return null;
  }
}

/**
 * Reenvía asincrónicamente los mensajes entrantes a n8n para el bot de IA
 */
async function forwardToN8n(eventData) {
  try {
    const cfg = getConfig();
    const n8nUrl = (process.env.N8N_WEBHOOK_URL || cfg.n8n_webhook_url || '').trim();
    if (!n8nUrl) {
      console.warn('[n8n Forward] Sin URL de webhook de n8n configurada.');
      return { ok: false, error: 'sin_url_configurada' };
    }

    console.log(`[n8n Forward] Reenviando mensaje entrante a n8n: ${n8nUrl}`);
    const res = await fetch(n8nUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': WA_DEFAULT_N8N_API_KEY,
        'x-source': 'segucar-backend'
      },
      body: JSON.stringify(eventData)
    });
    const respText = await res.text();
    console.log(`[n8n Forward] Respuesta n8n: HTTP ${res.status} | Body: ${respText.substring(0, 200)}`);
    if (!res.ok) {
      console.warn(`⚠️ [n8n Forward Warning] n8n rechazó el mensaje (HTTP ${res.status}): ${respText}`);
    }
    return {
      ok: res.ok,
      status: res.status,
      url: n8nUrl,
      response: respText
    };
  } catch (err) {
    console.error('[n8n Forward Error] Falló reenvío a n8n:', err.message);
    return {
      ok: false,
      error: err.message
    };
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

function parseDbDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  const str = String(dateStr).trim();
  if (str.endsWith('Z') || str.includes('T')) {
    return new Date(str);
  }
  // Formato SQLite "YYYY-MM-DD HH:mm:ss" es UTC
  return new Date(str.replace(' ', 'T') + 'Z');
}

/**
 * Obtiene el estado actual del bot para un número de teléfono.
 * Evalúa automáticamente si el tiempo de silencio ya expiró.
 */
function getEstadoBot(phone) {
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return { bot_activo: true, estado_bot: 'activo' };

  try {
    const row = db.prepare(`
      SELECT telefono, cliente_id, estado_bot, silenciado_hasta, motivo, ultimo_autor, updated_at
      FROM conversaciones_estado_bot
      WHERE telefono = ?
    `).get(formattedPhone);

    if (!row) {
      return {
        telefono: formattedPhone,
        bot_activo: true,
        estado_bot: 'activo',
        silenciado_hasta: null,
        motivo: null,
        ultimo_autor: null
      };
    }

    // Evaluar si el silencio expiró
    if (row.estado_bot === 'silenciado') {
      if (row.silenciado_hasta) {
        const parsedDate = parseDbDate(row.silenciado_hasta);
        const expiresAt = parsedDate ? parsedDate.getTime() : 0;
        const now = Date.now();
        if (now >= expiresAt) {
          // Expiró: reactivar automáticamente
          db.prepare(`
            UPDATE conversaciones_estado_bot
            SET estado_bot = 'activo', silenciado_hasta = NULL, motivo = 'expiracion_silencio', updated_at = CURRENT_TIMESTAMP
            WHERE telefono = ?
          `).run(formattedPhone);

          return {
            telefono: formattedPhone,
            bot_activo: true,
            estado_bot: 'activo',
            silenciado_hasta: null,
            motivo: 'expiracion_silencio',
            ultimo_autor: row.ultimo_autor
          };
        }
      }
      return {
        telefono: formattedPhone,
        bot_activo: false,
        estado_bot: 'silenciado',
        silenciado_hasta: row.silenciado_hasta,
        motivo: row.motivo,
        ultimo_autor: row.ultimo_autor
      };
    }

    return {
      telefono: formattedPhone,
      bot_activo: true,
      estado_bot: row.estado_bot || 'activo',
      silenciado_hasta: null,
      motivo: row.motivo,
      ultimo_autor: row.ultimo_autor
    };
  } catch (err) {
    console.error('[WA getEstadoBot Error]', err.message);
    return { bot_activo: true, estado_bot: 'activo' };
  }
}

/**
 * Silencia el bot para una conversación por N horas (default 24h)
 */
function silenciarBot(phone, { horas = 24, motivo = 'intervencion_humano_crm', clienteId = null, autor = 'humano' } = {}) {
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return { ok: false, error: 'Teléfono inválido' };

  try {
    const validClienteId = resolveValidClienteId(clienteId);
    const expiresAt = new Date(Date.now() + horas * 3600 * 1000).toISOString();

    db.prepare(`
      INSERT INTO conversaciones_estado_bot (telefono, cliente_id, estado_bot, silenciado_hasta, motivo, ultimo_autor, updated_at)
      VALUES (?, ?, 'silenciado', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telefono) DO UPDATE SET
        cliente_id = COALESCE(excluded.cliente_id, cliente_id),
        estado_bot = 'silenciado',
        silenciado_hasta = excluded.silenciado_hasta,
        motivo = excluded.motivo,
        ultimo_autor = excluded.ultimo_autor,
        updated_at = CURRENT_TIMESTAMP
    `).run(formattedPhone, validClienteId, expiresAt, motivo, autor);

    console.log(`[WA Bot State] ⏸️ Bot silenciado para ${formattedPhone} por ${horas}hs (Hasta ${expiresAt}) | Motivo: ${motivo}`);
    return { ok: true, telefono: formattedPhone, estado_bot: 'silenciado', silenciado_hasta: expiresAt, motivo };
  } catch (err) {
    console.error('[WA silenciarBot Error]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Reactiva el bot inmediatamente para un número
 */
function activarBot(phone) {
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return { ok: false, error: 'Teléfono inválido' };

  try {
    db.prepare(`
      INSERT INTO conversaciones_estado_bot (telefono, estado_bot, silenciado_hasta, motivo, ultimo_autor, updated_at)
      VALUES (?, 'activo', NULL, 'reactivado_manual', 'humano', CURRENT_TIMESTAMP)
      ON CONFLICT(telefono) DO UPDATE SET
        estado_bot = 'activo',
        silenciado_hasta = NULL,
        motivo = 'reactivado_manual',
        ultimo_autor = 'humano',
        updated_at = CURRENT_TIMESTAMP
    `).run(formattedPhone);

    console.log(`[WA Bot State] ▶️ Bot reactivado para ${formattedPhone}`);
    return { ok: true, telefono: formattedPhone, estado_bot: 'activo' };
  } catch (err) {
    console.error('[WA activarBot Error]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía un mensaje de texto libre a través de 360dialog API (dentro de ventana de 24hs)
 */
async function sendTextMessage(clienteId, phone, text, { origen = 'bot', autor = null } = {}) {
  const cfg = getConfig();
  const formattedPhone = formatPhone(phone);
  const validClienteId = resolveValidClienteId(clienteId);

  if (cfg.modo === 'simulacion' || !cfg.api_key) {
    console.log(`[WA Simulación] Mensaje a ${formattedPhone}: "${text}" (Origen: ${origen})`);
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, origen, autor)
      VALUES (?, 'saliente', ?, ?, 'texto', 'enviado', ?, ?)
    `).run(validClienteId, formattedPhone, text, origen, autor);
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
        INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, meta_data, origen, autor)
        VALUES (?, 'saliente', ?, ?, 'texto', 'fallido', ?, ?, ?)
      `).run(validClienteId, formattedPhone, text, JSON.stringify(data), origen, autor);
      return { ok: false, error: data.error || 'Error al enviar por 360dialog' };
    }

    const waMsgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data, origen, autor)
      VALUES (?, ?, 'saliente', ?, ?, 'texto', 'enviado', ?, ?, ?)
    `).run(validClienteId, waMsgId, formattedPhone, text, JSON.stringify(data), origen, autor);

    return { ok: true, wa_message_id: waMsgId, id: res.lastInsertRowid };
  } catch (err) {
    console.error('[WA Service Exception]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Envía una plantilla pre-aprobada de WhatsApp
 */
async function sendTemplateMessage(clienteId, phone, templateName, languageCode = 'es_AR', parameters = [], { origen = 'bot', autor = null } = {}) {
  const cfg = getConfig();
  const formattedPhone = formatPhone(phone);
  const validClienteId = resolveValidClienteId(clienteId);

  if (cfg.modo === 'simulacion' || !cfg.api_key) {
    console.log(`[WA Simulación Plantilla] ${templateName} a ${formattedPhone} (Origen: ${origen})`);
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, origen, autor)
      VALUES (?, 'saliente', ?, ?, 'plantilla', 'enviado', ?, ?)
    `).run(validClienteId, formattedPhone, `[Plantilla: ${templateName}]`, origen, autor);
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
        INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, meta_data, origen, autor)
        VALUES (?, 'saliente', ?, ?, 'plantilla', 'fallido', ?, ?, ?)
      `).run(validClienteId, formattedPhone, `[Plantilla: ${templateName}]`, JSON.stringify(data), origen, autor);
      return { ok: false, error: data.meta?.developer_message || data.error?.message || data.error || 'Error al enviar plantilla' };
    }

    const waMsgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data, origen, autor)
      VALUES (?, ?, 'saliente', ?, ?, 'plantilla', 'enviado', ?, ?, ?)
    `).run(validClienteId, waMsgId, formattedPhone, `[Plantilla: ${templateName}]`, JSON.stringify(data), origen, autor);

    return { ok: true, wa_message_id: waMsgId, id: res.lastInsertRowid };
  } catch (err) {
    console.error('[WA Template Exception]', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Procesa webhooks entrantes de Meta / 360dialog (Mensajes entrantes y estados de entrega)
 */
async function processWebhookPayload(payload) {
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

    const n8nResults = [];

    // 2. Procesar Mensajes Entrantes de Clientes
    if (value.messages && value.messages.length > 0) {
      for (const msg of value.messages) {
        const fromPhone = formatPhone(msg.from);
        const waMsgId = msg.id;

        // Caso especial 1: Mensaje Editado por el usuario en WhatsApp
        if (msg.type === 'edit' && msg.edit) {
          const origId = msg.edit.original_message_id;
          const editedText = msg.edit.message?.text?.body || msg.edit.text?.body || '';

          console.log(`[WA Edición] Mensaje original ${origId} de ${fromPhone} editado a: "${editedText}"`);

          if (origId && editedText) {
            try {
              db.prepare(`
                UPDATE mensajes_whatsapp
                SET mensaje = ?, meta_data = ?
                WHERE wa_message_id = ?
              `).run(editedText, JSON.stringify(msg), origId);
            } catch (editErr) {
              console.error('[WA Edición Error]', editErr.message);
            }
          }

          // No reenviar al bot de n8n para no generar respuestas duplicadas
          continue;
        }

        // Caso especial 2: Reacciones con emojis (👍, ❤️, etc.)
        if (msg.type === 'reaction') {
          console.log(`[WA Reacción] De ${fromPhone}: ${msg.reaction?.emoji || 'emoji'}`);
          continue;
        }

        let textContent = '';
        let mediaId = null;

        if (msg.type === 'text' && msg.text) {
          textContent = msg.text.body;
        } else if (msg.type === 'image' && msg.image) {
          const caption = msg.image.caption ? ` ${msg.image.caption}` : '';
          mediaId = msg.image.id || '';
          textContent = `📷 [Imagen recibida:${mediaId}]${caption}`;
        } else if (msg.type === 'document' && msg.document) {
          mediaId = msg.document.id || '';
          const fileName = msg.document.filename || 'Comprobante.pdf';
          textContent = `📄 [Documento:${mediaId}:${fileName}]`;
        } else if ((msg.type === 'audio' || msg.type === 'voice') && (msg.audio || msg.voice)) {
          mediaId = (msg.audio && msg.audio.id) || (msg.voice && msg.voice.id) || '';
          textContent = `🎤 [Audio recibido:${mediaId}]`;
        } else {
          textContent = `[Mensaje tipo: ${msg.type}]`;
        }

        // Buscar cliente por teléfono
        const cliente = db.prepare(`
          SELECT id, nombre, dni FROM clientes 
          WHERE replace(replace(replace(telefono, ' ', ''), '+', ''), '-', '') LIKE ?
          LIMIT 1
        `).get(`%${fromPhone.slice(-8)}%`);

        const clienteId = cliente ? cliente.id : null;

        db.prepare(`
          INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data, origen, autor)
          VALUES (?, ?, 'entrante', ?, ?, ?, 'recibido', ?, 'cliente', 'cliente')
        `).run(clienteId, waMsgId, fromPhone, textContent, msg.type || 'texto', JSON.stringify(msg));

        // Verificar si el bot está silenciado para esta conversación
        const botState = getEstadoBot(fromPhone);

        if (!botState.bot_activo) {
          console.log(`[WA Webhook] 👤 Mensaje de ${fromPhone} guardado en bandeja pero NO reenviado a n8n (Bot silenciado por ${botState.motivo || 'atención humana'} hasta ${botState.silenciado_hasta})`);
          n8nResults.push({
            telefono: fromPhone,
            bot_silenciado: true,
            motivo: botState.motivo,
            silenciado_hasta: botState.silenciado_hasta
          });
        } else {
          console.log(`[WA Entrante] De ${fromPhone} (Cliente ${clienteId || 'Desconocido'}): "${textContent}"`);

          // Reenviar a n8n para el bot de IA / automatización
          const fwd = await forwardToN8n({
            event: 'incoming_message',
            cliente_id: clienteId,
            cliente_nombre: cliente ? cliente.nombre : null,
            cliente_dni: cliente ? cliente.dni : null,
            telefono: fromPhone,
            mensaje: textContent,
            tipo: msg.type || 'texto',
            wa_message_id: waMsgId,
            media_id: mediaId,
            media_url: mediaId ? `https://segucar-kuu2.onrender.com/api/whatsapp/media/${mediaId}` : null,
            timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
            raw_message: msg
          });
          n8nResults.push({
            telefono: fromPhone,
            bot_silenciado: false,
            n8n_response: fwd
          });
        }
      }
    }

    return { ok: true, processed: true, n8n_dispatches: n8nResults };
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
        COALESCE(c.nombre, 'Contacto ' || m.telefono) as cliente_nombre,
        COALESCE(c.telefono, m.telefono) as cliente_telefono,
        m.telefono,
        m.mensaje as ultimo_mensaje,
        m.direccion as ultima_direccion,
        m.estado as ultimo_estado,
        m.created_at as ultima_fecha,
        m.origen as ultimo_origen,
        COALESCE(eb.estado_bot, 'activo') as estado_bot,
        eb.silenciado_hasta,
        eb.motivo as motivo_silencio,
        (
          SELECT COUNT(*) 
          FROM mensajes_whatsapp m2 
          WHERE ((m.cliente_id IS NOT NULL AND m2.cliente_id = m.cliente_id) OR (m.cliente_id IS NULL AND m2.telefono = m.telefono))
            AND m2.direccion = 'entrante' AND m2.estado = 'recibido'
        ) as sin_leer
      FROM mensajes_whatsapp m
      LEFT JOIN clientes c ON m.cliente_id = c.id
      LEFT JOIN conversaciones_estado_bot eb ON eb.telefono = m.telefono
      WHERE m.id IN (
        SELECT MAX(id) FROM mensajes_whatsapp GROUP BY COALESCE(cliente_id, telefono)
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
async function sendMediaMessage(clienteId, phone, fileUrl, fileName, mimeType = 'application/pdf', { origen = 'bot', autor = null } = {}) {
  const cfg = getConfig();
  const formattedPhone = formatPhone(phone);
  const validClienteId = resolveValidClienteId(clienteId);

  if (cfg.modo === 'simulacion' || !cfg.api_key) {
    console.log(`[WA Simulación Archivo] ${fileName} (${fileUrl}) a ${formattedPhone} (Origen: ${origen})`);
    const res = db.prepare(`
      INSERT INTO mensajes_whatsapp (cliente_id, direccion, telefono, mensaje, tipo, estado, origen, autor)
      VALUES (?, 'saliente', ?, ?, 'archivo', 'enviado', ?, ?)
    `).run(validClienteId, formattedPhone, `📎 [Archivo: ${fileName}] (${fileUrl})`, origen, autor);
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
      INSERT INTO mensajes_whatsapp (cliente_id, wa_message_id, direccion, telefono, mensaje, tipo, estado, meta_data, origen, autor)
      VALUES (?, ?, 'saliente', ?, ?, 'archivo', 'enviado', ?, ?, ?)
    `).run(validClienteId, waMsgId, formattedPhone, `📎 ${fileName} (${fileUrl})`, JSON.stringify(data), origen, autor);

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
  getEstadoBot,
  silenciarBot,
  activarBot,
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  processWebhookPayload,
  forwardToN8n,
  getChatHistory,
  getConversacionesBandeja
};
