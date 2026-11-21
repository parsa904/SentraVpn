use thiserror::Error;

#[derive(Error, Debug)]
pub enum ClientError {
    #[error("خطای شبکه یا ارتباط با سرور مرکزی: {0}")]
    Network(String),

    #[error("کد ورود نامعتبر است یا منقضی شده")]
    InvalidAuthCode,

    #[error("نشست کاربری نامعتبر است")]
    InvalidSession,

    #[error("اجرای هسته sing-box با شکست مواجه شد: {0}")]
    SidecarExecution(String),

    #[error("پیکربندی sing-box نامعتبر است: {0}")]
    ConfigError(String),

    #[error("خطای فایل یا ورودی/خروجی: {0}")]
    Io(#[from] std::io::Error),
}
