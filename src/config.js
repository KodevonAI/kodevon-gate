// Configuración desde variables de entorno.
const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dbPath: env.DB_PATH || './data/gate.db',
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',

  instagram: {
    appSecret: env.IG_APP_SECRET || '',
    verifyToken: env.IG_VERIFY_TOKEN || '',
    accessToken: env.IG_ACCESS_TOKEN || '',
    graphVersion: env.IG_GRAPH_VERSION || 'v23.0',
    followButton: env.IG_FOLLOW_BUTTON || '✅ Ya te sigo',
  },

  tiktok: {
    appId: env.TIKTOK_APP_ID || '',
    appSecret: env.TIKTOK_APP_SECRET || '',
    apiVersion: env.TIKTOK_API_VERSION || 'v1.3',
    username: (env.TIKTOK_USERNAME || '').replace(/^@/, '').toLowerCase(),
    // apify | none
    followCheck: env.TIKTOK_FOLLOW_CHECK || 'apify',
    apifyToken: env.APIFY_TOKEN || '',
    apifyActor: env.APIFY_ACTOR || 'unseenuser~tiktok-followers-following-scraper',
    followCheckMax: Number(env.TIKTOK_FOLLOW_CHECK_MAX || 50),
    // palabras que cuentan como "ya te seguí"
    confirmWords: (env.TIKTOK_CONFIRM_WORDS || 'listo,ya,ya te sigo,hecho,done,ok')
      .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean),
  },

  youtube: {
    clientId: env.YT_CLIENT_ID || '',
    clientSecret: env.YT_CLIENT_SECRET || '',
    pollSeconds: Number(env.YT_POLL_SECONDS || 120),
  },
};
