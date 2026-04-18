//! Session Management - Live Mode State Machine
//!
//! Manages sync session lifecycle including:
//! - Session state transitions (idle → syncing → live → closed)
//! - Keep-alive ping/pong with configurable intervals
//! - Automatic reconnection with exponential backoff
//! - Connection health metrics (RTT, jitter)

use std::time::Duration;
use web_time::Instant;
use std::collections::VecDeque;

/// Session configuration
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Ping interval in milliseconds (default: 15000ms = 15s)
    pub ping_interval_ms: u64,

    /// Ping timeout in milliseconds (default: 10000ms = 10s)
    pub ping_timeout_ms: u64,

    /// Receive timeout in milliseconds (default: 30000ms = 30s)
    pub receive_timeout_ms: u64,

    /// Maximum retry attempts for reconnection
    pub max_retries: u32,

    /// Base delay for exponential backoff (milliseconds)
    pub base_retry_delay_ms: u64,

    /// Maximum delay cap for exponential backoff (milliseconds)
    pub max_retry_delay_ms: u64,

    /// Number of RTT samples to keep for metrics
    pub rtt_sample_size: usize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            ping_interval_ms: 15000,      // 15 seconds
            ping_timeout_ms: 10000,        // 10 seconds
            receive_timeout_ms: 30000,     // 30 seconds
            max_retries: 5,
            base_retry_delay_ms: 500,
            max_retry_delay_ms: 30000,     // 30 seconds max
            rtt_sample_size: 10,
        }
    }
}

/// Session state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Initial state, not connected
    Idle,
    /// Connecting to peer
    Connecting,
    /// Exchanging version vectors
    ExchangingVersions,
    /// Syncing CRDT updates
    SyncingUpdates,
    /// Syncing blobs
    SyncingBlobs,
    /// Live mode - incremental sync
    Live,
    /// Session closed gracefully
    Closed,
    /// Error state
    Error,
}

impl SessionState {
    /// Check if session is in a terminal state
    pub fn is_terminal(&self) -> bool {
        matches!(self, SessionState::Closed | SessionState::Error)
    }

    /// Check if session is active (connected and syncing or live)
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            SessionState::ExchangingVersions
                | SessionState::SyncingUpdates
                | SessionState::SyncingBlobs
                | SessionState::Live
        )
    }
}

/// Ping state for keep-alive
#[derive(Debug, Clone)]
pub struct PingState {
    /// Current ping sequence number
    pub seq: u32,
    /// Time last ping was sent
    pub last_ping_sent: Option<Instant>,
    /// Time last pong was received
    pub last_pong_received: Option<Instant>,
    /// Whether we're waiting for a pong
    pub awaiting_pong: bool,
    /// Consecutive missed pongs
    pub missed_pongs: u32,
}

impl Default for PingState {
    fn default() -> Self {
        Self {
            seq: 0,
            last_ping_sent: None,
            last_pong_received: None,
            awaiting_pong: false,
            missed_pongs: 0,
        }
    }
}

/// Connection health metrics
#[derive(Debug, Clone)]
pub struct HealthMetrics {
    /// Round-trip time samples (milliseconds)
    rtt_samples: VecDeque<u64>,
    /// Maximum RTT samples to keep
    max_samples: usize,
    /// Bytes sent
    pub bytes_sent: u64,
    /// Bytes received
    pub bytes_received: u64,
    /// Messages sent
    pub messages_sent: u64,
    /// Messages received
    pub messages_received: u64,
    /// Last activity time
    pub last_activity: Instant,
}

impl HealthMetrics {
    pub fn new(max_samples: usize) -> Self {
        Self {
            rtt_samples: VecDeque::with_capacity(max_samples),
            max_samples,
            bytes_sent: 0,
            bytes_received: 0,
            messages_sent: 0,
            messages_received: 0,
            last_activity: Instant::now(),
        }
    }

    /// Record a round-trip time sample
    pub fn record_rtt(&mut self, rtt_ms: u64) {
        if self.rtt_samples.len() >= self.max_samples {
            self.rtt_samples.pop_front();
        }
        self.rtt_samples.push_back(rtt_ms);
    }

    /// Get average RTT in milliseconds
    pub fn avg_rtt_ms(&self) -> Option<u64> {
        if self.rtt_samples.is_empty() {
            None
        } else {
            let sum: u64 = self.rtt_samples.iter().sum();
            Some(sum / self.rtt_samples.len() as u64)
        }
    }

    /// Get RTT jitter (standard deviation approximation)
    pub fn jitter_ms(&self) -> Option<u64> {
        if self.rtt_samples.len() < 2 {
            return None;
        }

        let avg = self.avg_rtt_ms()?;
        let variance: u64 = self.rtt_samples
            .iter()
            .map(|&rtt| {
                let diff = if rtt > avg { rtt - avg } else { avg - rtt };
                diff * diff
            })
            .sum::<u64>() / self.rtt_samples.len() as u64;

        // Integer square root approximation
        Some((variance as f64).sqrt() as u64)
    }

    /// Get minimum RTT
    pub fn min_rtt_ms(&self) -> Option<u64> {
        self.rtt_samples.iter().min().copied()
    }

    /// Get maximum RTT
    pub fn max_rtt_ms(&self) -> Option<u64> {
        self.rtt_samples.iter().max().copied()
    }

    /// Record bytes sent
    pub fn record_sent(&mut self, bytes: usize) {
        self.bytes_sent += bytes as u64;
        self.messages_sent += 1;
        self.last_activity = Instant::now();
    }

    /// Record bytes received
    pub fn record_received(&mut self, bytes: usize) {
        self.bytes_received += bytes as u64;
        self.messages_received += 1;
        self.last_activity = Instant::now();
    }

    /// Time since last activity
    pub fn idle_duration(&self) -> Duration {
        self.last_activity.elapsed()
    }
}

/// Reconnection state
#[derive(Debug, Clone)]
pub struct ReconnectState {
    /// Current retry attempt (0 = first try)
    pub attempts: u32,
    /// Time of last reconnection attempt
    pub last_attempt: Option<Instant>,
    /// Whether reconnection is in progress
    pub in_progress: bool,
}

impl Default for ReconnectState {
    fn default() -> Self {
        Self {
            attempts: 0,
            last_attempt: None,
            in_progress: false,
        }
    }
}

impl ReconnectState {
    /// Calculate next retry delay using exponential backoff
    pub fn next_delay(&self, config: &SessionConfig) -> Duration {
        let delay_ms = config.base_retry_delay_ms
            .saturating_mul(2u64.saturating_pow(self.attempts));
        let capped_delay = delay_ms.min(config.max_retry_delay_ms);
        Duration::from_millis(capped_delay)
    }

    /// Check if we should retry
    pub fn should_retry(&self, config: &SessionConfig) -> bool {
        self.attempts < config.max_retries && !self.in_progress
    }

    /// Record a retry attempt
    pub fn record_attempt(&mut self) {
        self.attempts += 1;
        self.last_attempt = Some(Instant::now());
        self.in_progress = true;
    }

    /// Mark reconnection as complete (success or give up)
    pub fn complete(&mut self, success: bool) {
        self.in_progress = false;
        if success {
            self.attempts = 0;
        }
    }
}

/// Live mode session manager
pub struct LiveModeSession {
    /// Session configuration
    config: SessionConfig,
    /// Current session state
    state: SessionState,
    /// Ping/pong state
    ping: PingState,
    /// Connection health metrics
    metrics: HealthMetrics,
    /// Reconnection state
    reconnect: ReconnectState,
    /// Peer ID
    peer_id: String,
    /// Session start time
    started_at: Option<Instant>,
    /// Time we entered live mode
    live_since: Option<Instant>,
    /// Last error message
    last_error: Option<String>,
}

impl LiveModeSession {
    /// Create a new session
    pub fn new(peer_id: String, config: SessionConfig) -> Self {
        Self {
            metrics: HealthMetrics::new(config.rtt_sample_size),
            config,
            state: SessionState::Idle,
            ping: PingState::default(),
            reconnect: ReconnectState::default(),
            peer_id,
            started_at: None,
            live_since: None,
            last_error: None,
        }
    }

    /// Get current state
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// Get peer ID
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Get configuration
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    /// Get health metrics
    pub fn metrics(&self) -> &HealthMetrics {
        &self.metrics
    }

    /// Get mutable health metrics
    pub fn metrics_mut(&mut self) -> &mut HealthMetrics {
        &mut self.metrics
    }

    /// Get ping state
    pub fn ping_state(&self) -> &PingState {
        &self.ping
    }

    /// Get reconnection state
    pub fn reconnect_state(&self) -> &ReconnectState {
        &self.reconnect
    }

    /// Get last error
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Check if in live mode
    pub fn is_live(&self) -> bool {
        self.state == SessionState::Live
    }

    /// Duration in live mode
    pub fn live_duration(&self) -> Option<Duration> {
        self.live_since.map(|t| t.elapsed())
    }

    /// Total session duration
    pub fn session_duration(&self) -> Option<Duration> {
        self.started_at.map(|t| t.elapsed())
    }

    // =========================================================================
    // State Transitions
    // =========================================================================

    /// Start the session (transition: Idle → Connecting)
    pub fn start(&mut self) -> Result<(), SessionError> {
        if self.state != SessionState::Idle {
            return Err(SessionError::InvalidTransition {
                from: self.state,
                to: SessionState::Connecting,
            });
        }
        self.state = SessionState::Connecting;
        self.started_at = Some(Instant::now());
        Ok(())
    }

    /// Begin version exchange (transition: Connecting → ExchangingVersions)
    pub fn begin_version_exchange(&mut self) -> Result<(), SessionError> {
        if self.state != SessionState::Connecting {
            return Err(SessionError::InvalidTransition {
                from: self.state,
                to: SessionState::ExchangingVersions,
            });
        }
        self.state = SessionState::ExchangingVersions;
        Ok(())
    }

    /// Begin update sync (transition: ExchangingVersions → SyncingUpdates)
    pub fn begin_update_sync(&mut self) -> Result<(), SessionError> {
        if self.state != SessionState::ExchangingVersions {
            return Err(SessionError::InvalidTransition {
                from: self.state,
                to: SessionState::SyncingUpdates,
            });
        }
        self.state = SessionState::SyncingUpdates;
        Ok(())
    }

    /// Begin blob sync (transition: SyncingUpdates → SyncingBlobs)
    pub fn begin_blob_sync(&mut self) -> Result<(), SessionError> {
        if self.state != SessionState::SyncingUpdates {
            return Err(SessionError::InvalidTransition {
                from: self.state,
                to: SessionState::SyncingBlobs,
            });
        }
        self.state = SessionState::SyncingBlobs;
        Ok(())
    }

    /// Enter live mode (transition: SyncingUpdates|SyncingBlobs → Live)
    pub fn enter_live_mode(&mut self) -> Result<(), SessionError> {
        if !matches!(self.state, SessionState::SyncingUpdates | SessionState::SyncingBlobs) {
            return Err(SessionError::InvalidTransition {
                from: self.state,
                to: SessionState::Live,
            });
        }
        self.state = SessionState::Live;
        self.live_since = Some(Instant::now());
        self.reconnect.complete(true);
        Ok(())
    }

    /// Close the session gracefully
    pub fn close(&mut self) {
        self.state = SessionState::Closed;
    }

    /// Set error state
    pub fn set_error(&mut self, error: String) {
        self.last_error = Some(error);
        self.state = SessionState::Error;
    }

    /// Reset for reconnection
    pub fn reset_for_reconnect(&mut self) {
        self.state = SessionState::Idle;
        self.ping = PingState::default();
        self.live_since = None;
        // Keep metrics and reconnect state
    }

    // =========================================================================
    // Ping/Pong Handling
    // =========================================================================

    /// Create a ping message (returns sequence number)
    pub fn create_ping(&mut self) -> u32 {
        self.ping.seq += 1;
        self.ping.last_ping_sent = Some(Instant::now());
        self.ping.awaiting_pong = true;
        self.ping.seq
    }

    /// Handle a pong response
    pub fn handle_pong(&mut self, seq: u32) -> Result<u64, SessionError> {
        if !self.ping.awaiting_pong {
            return Err(SessionError::UnexpectedPong);
        }

        if seq != self.ping.seq {
            return Err(SessionError::PongSeqMismatch {
                expected: self.ping.seq,
                received: seq,
            });
        }

        let now = Instant::now();
        let rtt_ms = self.ping.last_ping_sent
            .map(|t| now.duration_since(t).as_millis() as u64)
            .unwrap_or(0);

        self.ping.last_pong_received = Some(now);
        self.ping.awaiting_pong = false;
        self.ping.missed_pongs = 0;

        self.metrics.record_rtt(rtt_ms);

        Ok(rtt_ms)
    }

    /// Handle a missed pong (ping timed out)
    pub fn handle_missed_pong(&mut self) {
        self.ping.missed_pongs += 1;
        self.ping.awaiting_pong = false;
    }

    /// Check if ping is overdue
    pub fn is_ping_overdue(&self) -> bool {
        if let Some(last_ping) = self.ping.last_ping_sent {
            if self.ping.awaiting_pong {
                return last_ping.elapsed() > Duration::from_millis(self.config.ping_timeout_ms);
            }
        }
        false
    }

    /// Check if it's time to send a ping
    pub fn should_send_ping(&self) -> bool {
        if self.state != SessionState::Live {
            return false;
        }
        if self.ping.awaiting_pong {
            return false;
        }

        match self.ping.last_ping_sent {
            Some(last) => last.elapsed() >= Duration::from_millis(self.config.ping_interval_ms),
            None => true,
        }
    }

    /// Check if connection appears dead (too many missed pongs)
    pub fn is_connection_dead(&self) -> bool {
        self.ping.missed_pongs >= 3
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    /// Check if we should attempt reconnection
    pub fn should_reconnect(&self) -> bool {
        self.state == SessionState::Error && self.reconnect.should_retry(&self.config)
    }

    /// Get delay before next reconnection attempt
    pub fn reconnect_delay(&self) -> Duration {
        self.reconnect.next_delay(&self.config)
    }

    /// Start a reconnection attempt
    pub fn start_reconnect(&mut self) {
        self.reconnect.record_attempt();
        self.reset_for_reconnect();
    }

    /// Mark reconnection as successful
    pub fn reconnect_succeeded(&mut self) {
        self.reconnect.complete(true);
    }

    /// Mark reconnection as failed
    pub fn reconnect_failed(&mut self, error: String) {
        self.reconnect.complete(false);
        self.set_error(error);
    }
}

/// Session errors
#[derive(Debug)]
pub enum SessionError {
    /// Invalid state transition
    InvalidTransition {
        from: SessionState,
        to: SessionState,
    },
    /// Received pong without pending ping
    UnexpectedPong,
    /// Pong sequence mismatch
    PongSeqMismatch {
        expected: u32,
        received: u32,
    },
    /// Session timeout
    Timeout(String),
    /// Protocol error
    Protocol(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::InvalidTransition { from, to } => {
                write!(f, "Invalid state transition: {:?} → {:?}", from, to)
            }
            SessionError::UnexpectedPong => write!(f, "Received pong without pending ping"),
            SessionError::PongSeqMismatch { expected, received } => {
                write!(f, "Pong sequence mismatch: expected {}, got {}", expected, received)
            }
            SessionError::Timeout(msg) => write!(f, "Timeout: {}", msg),
            SessionError::Protocol(msg) => write!(f, "Protocol error: {}", msg),
        }
    }
}

impl std::error::Error for SessionError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_session_state_transitions() {
        let config = SessionConfig::default();
        let mut session = LiveModeSession::new("peer1".into(), config);

        assert_eq!(session.state(), SessionState::Idle);

        session.start().unwrap();
        assert_eq!(session.state(), SessionState::Connecting);

        session.begin_version_exchange().unwrap();
        assert_eq!(session.state(), SessionState::ExchangingVersions);

        session.begin_update_sync().unwrap();
        assert_eq!(session.state(), SessionState::SyncingUpdates);

        session.begin_blob_sync().unwrap();
        assert_eq!(session.state(), SessionState::SyncingBlobs);

        session.enter_live_mode().unwrap();
        assert_eq!(session.state(), SessionState::Live);
        assert!(session.is_live());
    }

    #[test]
    fn test_invalid_transition() {
        let config = SessionConfig::default();
        let mut session = LiveModeSession::new("peer1".into(), config);

        // Can't enter live mode from idle
        let result = session.enter_live_mode();
        assert!(result.is_err());
    }

    #[test]
    fn test_ping_pong() {
        let config = SessionConfig::default();
        let mut session = LiveModeSession::new("peer1".into(), config);

        // Start session and enter live mode
        session.start().unwrap();
        session.begin_version_exchange().unwrap();
        session.begin_update_sync().unwrap();
        session.enter_live_mode().unwrap();

        // Create ping
        let seq = session.create_ping();
        assert_eq!(seq, 1);
        assert!(session.ping_state().awaiting_pong);

        // Handle pong
        let rtt = session.handle_pong(seq).unwrap();
        assert!(!session.ping_state().awaiting_pong);
        assert_eq!(session.ping_state().missed_pongs, 0);

        // RTT should be recorded
        assert!(session.metrics().avg_rtt_ms().is_some());
    }

    #[test]
    fn test_missed_pong() {
        let config = SessionConfig::default();
        let mut session = LiveModeSession::new("peer1".into(), config);

        session.start().unwrap();
        session.begin_version_exchange().unwrap();
        session.begin_update_sync().unwrap();
        session.enter_live_mode().unwrap();

        // Create ping and miss pong
        session.create_ping();
        session.handle_missed_pong();
        assert_eq!(session.ping_state().missed_pongs, 1);
        assert!(!session.is_connection_dead());

        // Miss more pongs
        session.create_ping();
        session.handle_missed_pong();
        session.create_ping();
        session.handle_missed_pong();

        assert_eq!(session.ping_state().missed_pongs, 3);
        assert!(session.is_connection_dead());
    }

    #[test]
    fn test_reconnect_backoff() {
        let config = SessionConfig {
            base_retry_delay_ms: 100,
            max_retry_delay_ms: 1000,
            max_retries: 5,
            ..Default::default()
        };

        let reconnect = ReconnectState::default();

        // First attempt: 100ms
        assert_eq!(reconnect.next_delay(&config).as_millis(), 100);

        // After 1 attempt: 200ms
        let mut reconnect = ReconnectState { attempts: 1, ..Default::default() };
        assert_eq!(reconnect.next_delay(&config).as_millis(), 200);

        // After 2 attempts: 400ms
        reconnect.attempts = 2;
        assert_eq!(reconnect.next_delay(&config).as_millis(), 400);

        // After 3 attempts: 800ms
        reconnect.attempts = 3;
        assert_eq!(reconnect.next_delay(&config).as_millis(), 800);

        // After 4 attempts: capped at 1000ms
        reconnect.attempts = 4;
        assert_eq!(reconnect.next_delay(&config).as_millis(), 1000);
    }

    #[test]
    fn test_health_metrics() {
        let mut metrics = HealthMetrics::new(5);

        // Record some RTT samples
        metrics.record_rtt(10);
        metrics.record_rtt(20);
        metrics.record_rtt(30);

        assert_eq!(metrics.avg_rtt_ms(), Some(20));
        assert_eq!(metrics.min_rtt_ms(), Some(10));
        assert_eq!(metrics.max_rtt_ms(), Some(30));
        assert!(metrics.jitter_ms().is_some());

        // Record bytes
        metrics.record_sent(100);
        metrics.record_received(200);

        assert_eq!(metrics.bytes_sent, 100);
        assert_eq!(metrics.bytes_received, 200);
        assert_eq!(metrics.messages_sent, 1);
        assert_eq!(metrics.messages_received, 1);
    }

    #[test]
    fn test_should_send_ping() {
        let config = SessionConfig {
            ping_interval_ms: 10, // Very short for testing
            ..Default::default()
        };
        let mut session = LiveModeSession::new("peer1".into(), config);

        // Not in live mode - shouldn't ping
        assert!(!session.should_send_ping());

        // Enter live mode
        session.start().unwrap();
        session.begin_version_exchange().unwrap();
        session.begin_update_sync().unwrap();
        session.enter_live_mode().unwrap();

        // First ping should be immediate
        assert!(session.should_send_ping());

        // After sending ping, shouldn't send another until pong
        session.create_ping();
        assert!(!session.should_send_ping());

        // After receiving pong, wait for interval
        session.handle_pong(1).unwrap();

        // Wait for ping interval
        thread::sleep(Duration::from_millis(15));
        assert!(session.should_send_ping());
    }
}
