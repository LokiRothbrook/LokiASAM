/// Represents a persistent RCON TCP connection to a running server.
pub struct RconConnection {
    pub server_id: String,
    pub host: String,
    pub port: u16,
    /// Whether the connection is currently authenticated.
    pub authenticated: bool,
}
