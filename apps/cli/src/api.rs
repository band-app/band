use crate::state;
use ureq::http;
use ureq::Body;

pub struct ApiClient {
    agent: ureq::Agent,
    base_url: String,
    token: Option<String>,
}

impl ApiClient {
    pub fn from_settings() -> Result<Self, String> {
        let settings = state::load_settings()?;
        let port = settings.web_server_port.unwrap_or(3456);
        let token = settings.token_secret;
        let agent = ureq::Agent::new_with_config(
            ureq::config::Config::builder()
                .http_status_as_error(false)
                .build(),
        );
        Ok(Self {
            agent,
            base_url: format!("http://127.0.0.1:{port}"),
            token,
        })
    }

    pub fn trpc_query(
        &self,
        procedure: &str,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let input_str =
            serde_json::to_string(input).map_err(|e| format!("Failed to serialize input: {e}"))?;
        let url = format!(
            "{}/trpc/{procedure}?input={}",
            self.base_url,
            urlencoded(&input_str),
        );

        let mut req = self.agent.get(&url);
        if let Some(ref token) = self.token {
            req = req.header("Cookie", &format!("band_token={token}"));
        }

        let response = req.call().map_err(|e| {
            format!("Cannot connect to Band web server. Make sure it's running.\n{e}")
        })?;

        parse_trpc_body(response)
    }

    pub fn trpc_query_no_input(&self, procedure: &str) -> Result<serde_json::Value, String> {
        let url = format!("{}/trpc/{procedure}", self.base_url);

        let mut req = self.agent.get(&url);
        if let Some(ref token) = self.token {
            req = req.header("Cookie", &format!("band_token={token}"));
        }

        let response = req.call().map_err(|e| {
            format!("Cannot connect to Band web server. Make sure it's running.\n{e}")
        })?;

        parse_trpc_body(response)
    }

    pub fn trpc_mutate(
        &self,
        procedure: &str,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let mut req = self
            .agent
            .post(&format!("{}/trpc/{procedure}", self.base_url))
            .header("Content-Type", "application/json");
        if let Some(ref token) = self.token {
            req = req.header("Cookie", &format!("band_token={token}"));
        }

        let response = req.send_json(input).map_err(|e| {
            format!("Cannot connect to Band web server. Make sure it's running.\n{e}")
        })?;

        parse_trpc_body(response)
    }
}

fn parse_trpc_body(mut response: http::Response<Body>) -> Result<serde_json::Value, String> {
    let status = response.status().as_u16();

    // Auth failure
    if status == 401 {
        return Err("Authentication failed. Check tokenSecret in settings.json".to_string());
    }

    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    // tRPC error response
    if let Some(error) = body.get("error") {
        let msg: &str = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Unknown error");
        return Err(msg.to_string());
    }

    // Non-200 without tRPC error body
    if status >= 400 {
        return Err(format!("Server returned HTTP {status}"));
    }

    Ok(body
        .get("result")
        .and_then(|r: &serde_json::Value| r.get("data"))
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

fn urlencoded(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push('%');
                result.push(HEX_UPPER[(b >> 4) as usize] as char);
                result.push(HEX_UPPER[(b & 0x0f) as usize] as char);
            }
        }
    }
    result
}

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";
