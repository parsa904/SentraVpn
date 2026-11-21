use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub database_url: String,
    pub teloxide_token: Option<String>,
    pub teloxide_proxy: Option<String>,
    pub admin_chat_id: i64,
}

impl Config {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();

        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8080);

        let base_url = env::var("BASE_URL")
            .unwrap_or_else(|_| format!("http://{}:{}", host, port));

        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite://sentra_local.db?mode=rwc".to_string());

        let teloxide_token = env::var("TELOXIDE_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty() && !t.contains("SAMPLE"));

        let teloxide_proxy = env::var("TELOXIDE_PROXY")
            .ok()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());

        let admin_chat_id = env::var("ADMIN_CHAT_ID")
            .ok()
            .and_then(|id| id.parse::<i64>().ok())
            .unwrap_or(0);

        Self {
            host,
            port,
            base_url,
            database_url,
            teloxide_token,
            teloxide_proxy,
            admin_chat_id,
        }
    }
}
