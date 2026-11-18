# Kodevon Gate

Automatización tipo ManyChat, propia y autoalojada, con **verificación de seguidor**:

| Plataforma | Flujo |
|---|---|
| **Instagram** | Comentario con palabra clave → respuesta pública → DM con botón "✅ Ya te sigo" → se verifica `is_user_follow_business` → se envía el contenido. También si escriben la palabra por DM. |
| **TikTok** | DM con palabra clave → se pide seguir y responder LISTO → se revisa la lista pública de "siguiendo" de la persona con Apify → contenido. Si la lista es privada, se entrega igual. |
| **YouTube** | Comentario con palabra clave → respuesta automática al comentario con el link (YouTube no tiene DMs). |

Panel en `/admin` (usuario/contraseña de `ADMIN_USER`/`ADMIN_PASSWORD`) para crear reglas, conectar cuentas y ver la actividad.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `BASE_URL` | sí | URL pública, ej. `https://gate.kodevon.com` |
| `ADMIN_PASSWORD` | sí | Contraseña del panel (`ADMIN_USER`, por defecto `admin`) |
| `IG_APP_SECRET` | IG | App Secret de la app de Meta (para validar webhooks) |
| `IG_VERIFY_TOKEN` | IG | Texto cualquiera; el mismo que pones en Meta al configurar el webhook |
| `IG_ACCESS_TOKEN` | IG | Token de la cuenta (también se puede pegar en el panel). Se renueva solo. |
| `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | TikTok | App de TikTok for Developers con Business Messaging API |
| `TIKTOK_USERNAME` | TikTok | Tu usuario de TikTok sin @ (para la verificación) |
| `APIFY_TOKEN` | TikTok | Token de Apify para revisar la lista de "siguiendo" |
| `TIKTOK_FOLLOW_CHECK` | no | `apify` (defecto) o `none` |
| `TIKTOK_FOLLOW_CHECK_MAX` | no | Cuántas cuentas de "siguiendo" revisar (defecto 50; el actor cobra por resultado) |
| `APIFY_ACTOR` | no | Actor de Apify (defecto `unseenuser~tiktok-followers-following-scraper`) |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET` | YouTube | OAuth Client (web) de Google Cloud con YouTube Data API v3 |
| `YT_POLL_SECONDS` | no | Cada cuánto revisar comentarios (defecto 120) |

Montar un volumen persistente en `/data` (base de datos SQLite).

## Conexión de cuentas

**Instagram (Meta → app → Instagram → API setup with Instagram login)**
1. Genera el token de la cuenta y pégalo en el panel.
2. En "Configure webhooks": Callback URL `BASE_URL/webhooks/instagram`, Verify token = `IG_VERIFY_TOKEN`. Suscribe `comments`, `messages`, `messaging_postbacks`.
3. En el panel, pulsa **Activar webhooks de la cuenta**.
4. Permisos: `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages`. La app debe estar en modo **Live**.

**TikTok** — cuenta Business. Redirect URI `BASE_URL/tiktok/callback`. En el panel: **Conectar cuenta** y luego **Registrar webhook**.

**YouTube** — Redirect URI autorizado `BASE_URL/youtube/callback`. En el panel: **Conectar canal**. La primera revisión marca los comentarios existentes como vistos sin responderlos.

## Desarrollo

```bash
npm install
npm test
ADMIN_PASSWORD=x node src/server.js
```

## API para automatizar reglas

Base: `https://gate.kodevon.com/api/v1` · Documentación JSON en `GET /api/v1` (pública).

Autenticación: header `Authorization: Bearer <API_KEY>` (o `X-API-Key`). La clave se genera sola al arrancar y se ve/rota en el panel → **Conexiones → API**. Si defines `API_KEY` en Coolify, esa tiene prioridad.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/status` | Conexión de cada plataforma y nº de reglas |
| GET | `/rules?platform=&active=` | Listar reglas |
| POST | `/rules` | Crear una regla (objeto) o varias (arreglo → 201 / 207 con resultados por ítem) |
| GET · PATCH · PUT · DELETE | `/rules/:id` | Ver, editar parcialmente o borrar |
| GET · POST | `/{instagram\|tiktok\|youtube}/rules` | Igual, fijando la plataforma |
| GET · PATCH · DELETE | `/{plataforma}/rules/:id` | Igual, validando la plataforma |

Campos: `name`, `keywords` (arreglo o texto separado por comas), `media_url` (link del reel/post de IG o video de YouTube; se convierte al ID), `public_reply`, `ask_follow_msg`, `not_following_msg`, `content_msg`, `active` (por defecto `true`). Variables: `{username}`, `{nombre}`.

Mínimo por plataforma (el resto toma textos por defecto):
- **instagram**: `keywords`, `content_msg`
- **tiktok**: `keywords`, `content_msg`
- **youtube**: `keywords`, `public_reply` (pon ahí el link)

```bash
curl -X POST https://gate.kodevon.com/api/v1/instagram/rules \
  -H "Authorization: Bearer $KGATE_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Guía Claude","keywords":["claude"],"media_url":"https://www.instagram.com/reel/XXXX/","content_msg":"Aquí tienes: https://..."}'
```
