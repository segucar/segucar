---
name: whatsapp-dispatch-safety
description: >-
  Protocolo de seguridad, calendarios hábiles y reglas de despacho de WhatsApp
  (Meta Cloud / 360dialog). Regula las 48 hs preventivas, exclusión de domingos/feriados,
  bloqueo de spam en mora > 96hs y respeto al silenciamiento por atención humana.
---

# 📲 Protocolo de Despacho Seguro de WhatsApp (360dialog / Meta API)

Esta skill consolida las reglas críticas para el envío de mensajes transaccionales y recordatorios de cobranza por WhatsApp, protegiendo el número corporativo contra bloqueos de Meta y evitando molestias a los asegurados.

## 📅 1. Calendario Hábil y Regla de 48 Horas Preventivas

- **Zona Horaria Oficial:** `America/Argentina/Buenos_Aires` ([getArgentinaNow](file:///Users/tomassuares/Desktop/Proyectos%20antygravity/Segucar%20gestion%20interna/SEGUCar%20-%20Gestion%20Interna/holidays_ar.js#L20)). Render y servidores en la nube corren en UTC, por lo que **nunca se debe usar `new Date().getDay()` sin conversión horaria**.
- **Días No Laborables:** Domingos y Feriados Nacionales de Argentina ([holidays_ar.js](file:///Users/tomassuares/Desktop/Proyectos%20antygravity/Segucar%20gestion%20interna/SEGUCar%20-%20Gestion%20Interna/holidays_ar.js)). En estos días se **pausa el despacho masivo automático**.
- **SEGUCar trabaja los Sábados**.
- **Recordatorio Preventivo (48 hs exactas - `calDiff === 2`):**
  - 📅 **Miércoles** ➔ Cuotas que vencen el Viernes
  - 📅 **Jueves** ➔ Cuotas que vencen el Sábado
  - 📅 **Viernes** ➔ Cuotas que vencen el Domingo ⚠️ *(Los vencimientos de domingo **NUNCA** se avisan en jueves)*
  - 📅 **Sábado** ➔ Cuotas que vencen el Lunes

## 🛑 2. Reglas de Exclusión y Cese de Mensajes

1. **Cese Total de WhatsApp post-96 hs:**
   - La mora crítica (+96 hs) fue eliminada del flujo activo.
   - El ciclo de cobranza termina estrictamente en **Segundo Aviso (96 hs)**.
   - **Cero envíos automáticos** a pólizas con mora mayor a 96 hs hábiles.
2. **Exclusión Comercial Estricta (Upsell):**
   - Las **Motos** están 100% excluidas de campañas de ampliación de cobertura (Upsell Plan C).
   - Cualquier cliente con deuda activa (`saldo > $0`) queda automáticamente excluido de campañas comerciales.
3. **Respeto al Silenciamiento por Atención Humana:**
   - Si un operador atiende al cliente desde el CRM, la tabla `conversaciones_estado_bot` fija `silenciado_hasta = datetime('now', '+24 hours')`.
   - El bot o scheduler **NO debe enviar mensajes** mientras el estado sea `silenciado`.

## 🛡️ 3. Validaciones Preflight y Anti-Spam Meta
- **Validación Preflight:** Todo envío individual o masivo debe pasar previamente por `/api/whatsapp/preflight`.
- **Cadencia Segura:** Delay mínimo de **2.5 segundos** entre mensajes consecutivos para respetar los límites de la API de WhatsApp Cloud.
- **Anti-Duplicación:** Idempotencia diaria por cliente y cuota para evitar contactar dos veces al mismo asegurado en 24 horas.
