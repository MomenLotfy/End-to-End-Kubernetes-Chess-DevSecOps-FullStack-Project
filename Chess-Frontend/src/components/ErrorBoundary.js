import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error, info) {
    if (process.env.NODE_ENV !== "production") console.error("Unhandled React error", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#130f0c", color: "#f4ead8", fontFamily: "system-ui" }}>
        <section style={{ textAlign: "center", padding: "2rem" }}>
          <h1>Chess could not continue</h1>
          <p>Your session is safe. Reload the page to reconnect.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </section>
      </main>
    );
  }
}
