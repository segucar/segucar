# 🛡️ Template Whitelabel — Sistema de Gestión de Seguros & Cobranzas

Maqueta Base Whitelabel para réplica y despliegue rápido en Productores Asesores de Seguros (PAS).

---

## 🚀 Requisitos Previos

- **Node.js**: versión 18 o superior.
- **npm**: incluido con Node.js.

---

## ⚙️ Configuración Whitelabel de Marca (`config.json`)

Toda la identidad de marca (Nombre, Logo SVG, Eslogan y Productor) está centralizada en el archivo `config.json` de la raíz:

```json
{
  "appName": "SEGUCar",
  "brandNameHtml": "SEGU<em>Car</em>",
  "appDescription": "Sistema de gestión de clientes, pólizas y cobranzas de seguros.",
  "producerName": "Nombre del Productor Asesor",
  "port": 3005
}
```

Al modificar este archivo, el sistema actualizará automáticamente el navbar, títulos de pestaña, mensajes de WhatsApp y reportes descargables.

---

## 🛠️ Instalación e Inicialización

1. **Instalar dependencias**:
   ```bash
   npm install
   ```

2. **Inicializar Base de Datos Limpia**:
   ```bash
   npm run init-db
   ```
   *Este comando resetea y crea el esquema SQLite vacio con las 7 plantillas base de WhatsApp listas para operar.*

3. **Iniciar Servidor**:
   ```bash
   npm start
   ```
   *Acceder en el navegador a: `http://localhost:3005`*

---

## 📋 Módulos Incluidos

1. **🏠 Dashboard / Panel de Control**: Accesos rápidos de gestión diaria y métricas de cobranza.
2. **💰 Cobranza**: Gestión de cuotas impagas, recordatorios preventivos (48hs) y avisos de mora (+96hs).
3. **🛡️ Renovaciones**: Control de vencimientos de póliza a 7 días y renovación de carteras.
4. **📊 Métricas**: Indicadores comerciales y embudo de conversión de gestiones WhatsApp.
5. **🔄 Recuperación**: Cartera histórica aislada para reactivación comercial de ex-clientes.
6. **📥 Importación**: Carga masiva mediante archivos Excel (`.xlsx`) y agencias VCF (`.vcf`).
7. **📋 Plantillas**: Editor dinámico de plantillas para WhatsApp Web.

---

## 📦 Estructura del Proyecto

```text
├── config.json              # Configuración central de marca Whitelabel
├── init-db.js               # Script de inicialización de BD SQLite vacía
├── server.js                # Servidor API Express
├── database.js              # Modelo y esquema SQLite (Better-SQLite3)
├── sync_nre.js              # Integración y scraping de pólizas/cuotas
├── scraper.js               # Búsqueda automatizada de teléfonos
├── public/                  # Frontend estático (HTML5/CSS3/JS Vanilla)
│   ├── css/styles.css       # Estilos visuales
│   └── js/config.js         # Gestor dinámico de marca
└── data/                    # Almacenamiento SQLite local
```
