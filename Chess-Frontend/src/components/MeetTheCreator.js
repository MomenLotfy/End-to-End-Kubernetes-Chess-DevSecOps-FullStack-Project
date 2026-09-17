import { useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import SettingsPanel from "./SettingsPanel";
import Button from "./ui/Button";
import Icon from "./ui/Icon";
import "./MeetTheCreator.css";

const TECHNOLOGIES = [
  "Linux",
  "Docker",
  "Docker Compose",
  "Git",
  "GitHub",
  "CI/CD",
  "Kubernetes",
  "AWS",
  "Terraform",
  "Jenkins",
  "Argo CD",
  "Prometheus",
  "Grafana",
  "PostgreSQL",
  "Redis",
  "Nginx",
];

const TIMELINE = [
  { year: "2022", label: "Computer Science Engineering" },
  { year: "2025", label: "Systems & Infrastructure" },
  { year: "2025–2026", label: "DevOps / DevSecOps" },
  { year: "2026", label: "Chess Platform" },
];

const themeVariables = (C) => ({
  "--creator-bg": C.bg,
  "--creator-bg-gradient": C.bgGradient || C.bg,
  "--creator-surface": C.surface,
  "--creator-surface-hover": C.surfaceHover || C.surface,
  "--creator-text": C.tx,
  "--creator-muted": C.txMut,
  "--creator-faint": C.txFaint,
  "--creator-accent": C.accent,
  "--creator-accent-hover": C.accentHv || C.accent,
  "--creator-gold": C.gold,
  "--creator-gold-soft": C.goldSoft,
  "--creator-border": C.border,
  "--creator-panel": C.pnl,
  "--creator-panel-border": C.pnlBd,
  "--creator-success": C.success,
});

function SectionHeading({ number, eyebrow, title, titleAccent, id }) {
  return (
    <div className="meet-creator__section-heading">
      <p className="meet-creator__section-kicker"><span>{number}</span>{eyebrow}</p>
      <h2 id={id}>{title} {titleAccent && <span>{titleAccent}</span>}</h2>
    </div>
  );
}

function DetailCard({ number, icon, title, children, items }) {
  return (
    <article className="meet-creator__detail-card cm-card">
      <div className="meet-creator__detail-card-top">
        <span className="meet-creator__detail-number">{number}</span>
        <span className="meet-creator__detail-icon" aria-hidden="true">{icon}</span>
      </div>
      <h3>{title}</h3>
      <div className="meet-creator__card-copy">{children}</div>
      {items && (
        <ul className="meet-creator__feature-list">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </article>
  );
}

export default function MeetTheCreator() {
  const { colors: C } = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  const scrollToEngineering = () => {
    document.getElementById("engineering-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="meet-creator cm-screen" style={themeVariables(C)}>
      <div className="meet-creator__ambient meet-creator__ambient--top" aria-hidden="true" />
      <div className="meet-creator__ambient meet-creator__ambient--bottom" aria-hidden="true" />

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <header className="meet-creator__header">
        <a className="meet-creator__brand" href="/" aria-label="Return to Chess Master home">
          <Icon name="chess-logo" size={54} />
          <span>CHESS MASTER</span>
        </a>
        <div className="meet-creator__header-actions">
          <span className="meet-creator__current-page">Meet the Creator</span>
          <button
            type="button"
            className="meet-creator__icon-button cm-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Open settings"
            title="Settings"
          >
            <Icon name="chess-strategy" size={23} />
          </button>
        </div>
      </header>

      <main>
        <section className="meet-creator__hero meet-creator__shell" aria-labelledby="creator-page-title">
          <div className="meet-creator__hero-copy">
            <p className="meet-creator__eyebrow"><span className="meet-creator__eyebrow-mark" />Meet the Creator</p>
            <h1 id="creator-page-title">Hi, I'm <span>Momen Lotfy</span></h1>
            <p className="meet-creator__role">Computer Science Engineer <b>·</b> DevOps / DevSecOps Engineer <b>·</b> Builder</p>
            <p className="meet-creator__intro">
              I build reliable, secure, production-ready systems — and this chess platform is where engineering discipline meets the joy of the game.
            </p>
            <div className="meet-creator__hero-actions">
              <Button variant="primary" onClick={scrollToEngineering}>
                Explore the Engineering <span aria-hidden="true">→</span>
              </Button>
              <a className="meet-creator__text-link" href="#journey">Read the story <span aria-hidden="true">↓</span></a>
            </div>
          </div>

          <div className="meet-creator__portrait-wrap">
            <div className="meet-creator__portrait-card" role="img" aria-label="ML monogram avatar for Momen Lotfy">
              <span className="meet-creator__portrait-corner meet-creator__portrait-corner--top">ML / 01</span>
              <span className="meet-creator__portrait-corner meet-creator__portrait-corner--bottom">BUILD WITH INTENT</span>
              <div className="meet-creator__portrait-grid" aria-hidden="true" />
              <div className="meet-creator__avatar">
                <span className="meet-creator__avatar-initials">ML</span>
                <span className="meet-creator__avatar-line" />
                <span className="meet-creator__avatar-caption">Momen Lotfy</span>
              </div>
              <div className="meet-creator__portrait-orbit meet-creator__portrait-orbit--one" aria-hidden="true" />
              <div className="meet-creator__portrait-orbit meet-creator__portrait-orbit--two" aria-hidden="true" />
            </div>
          </div>
        </section>

        <div className="meet-creator__shell meet-creator__content">
          <section className="meet-creator__section meet-creator__section--wide" aria-labelledby="more-than-chess-title">
            <SectionHeading
              number="01"
              eyebrow="The board is only the beginning"
              title="More Than Just"
              titleAccent="Chess"
              id="more-than-chess-title"
            />
            <div className="meet-creator__wide-content">
              <p className="meet-creator__section-lead">
                A chessboard is the visible surface. Underneath it lives a full product: React on the front end, Node.js and PostgreSQL on the back end, and Socket.io keeping multiplayer play in sync in real time.
              </p>
              <div className="meet-creator__signal-grid">
                <div className="meet-creator__signal-item"><span>01</span><strong>Product thinking</strong><p>Authentication, persistence, and a focused player experience.</p></div>
                <div className="meet-creator__signal-item"><span>02</span><strong>Real-time systems</strong><p>Multiplayer communication and state that stays synchronized.</p></div>
                <div className="meet-creator__signal-item"><span>03</span><strong>Production architecture</strong><p>Security and reliability considered from the first move.</p></div>
              </div>
            </div>
          </section>

          <section id="engineering-details" className="meet-creator__section" aria-labelledby="journey-title">
            <SectionHeading number="02" eyebrow="The path behind the platform" title="My Engineering" titleAccent="Journey" id="journey-title" />
            <div className="meet-creator__journey-layout">
              <div className="meet-creator__journey-intro">
                <p>
                  I started with Computer Science Engineering, then kept moving closer to the systems that make software dependable outside a local machine.
                </p>
                <p>
                  Linux, infrastructure, automation, cloud, CI/CD, Docker, Kubernetes, monitoring, and security shaped the way I build. The DevOps / DevSecOps mindset is not a checklist at the end — it is the habit of thinking about the whole path from code to a healthy running service.
                </p>
              </div>
              <div className="meet-creator__journey-principle">
                <span className="meet-creator__principle-mark" aria-hidden="true">♞</span>
                <p>Build the feature.<br /><em>Understand the system around it.</em></p>
              </div>
            </div>
          </section>

          <section className="meet-creator__section meet-creator__stack-section" aria-labelledby="devsecops-title">
            <SectionHeading number="03" eyebrow="The engineering toolkit" title="DevOps &" titleAccent="DevSecOps" id="devsecops-title" />
            <div className="meet-creator__stack-content">
              <p className="meet-creator__section-lead">
                The tools change with the problem. The standard stays the same: automate what can be automated, observe what is running, and make security part of the delivery path.
              </p>
              <div className="meet-creator__tech-chips" aria-label="DevOps and DevSecOps technologies">
                {TECHNOLOGIES.map((technology) => <span className="meet-creator__tech-chip cm-chip" key={technology}>{technology}</span>)}
              </div>
            </div>
          </section>

          <div className="meet-creator__card-grid">
            <DetailCard
              number="04"
              icon="♜"
              title="Why I Built This Project"
              items={["Real-time communication and synchronization", "Server-authoritative game logic", "Transactions, concurrency, and recovery"]}
            >
              <p>Multiplayer chess turns simple rules into a systems problem. The platform has to authenticate players, persist the right state, resolve concurrent actions, and keep every client aligned with the server.</p>
            </DetailCard>
            <DetailCard
              number="05"
              icon="◇"
              title="Security Matters"
              items={["HTTP-only cookies and refresh-token rotation", "CSRF, CORS, security headers, and rate limiting", "Validation, protected uploads, and secure password handling"]}
            >
              <p>Security is part of the user experience. Every request, upload, session, and password deserves a clear boundary and a safe failure mode.</p>
            </DetailCard>
          </div>

          <section className="meet-creator__production-card" aria-labelledby="production-title">
            <div className="meet-creator__production-index">06 <span /> PRODUCTION MINDSET</div>
            <div className="meet-creator__production-copy">
              <h2 id="production-title">From Development <span>to Production</span></h2>
              <p>Shipping is not the finish line. It is where the important questions begin:</p>
              <div className="meet-creator__question-list">
                <span>How will it deploy?</span>
                <span>How will we monitor it?</span>
                <span>How does it recover?</span>
                <span>What happens during a database failure?</span>
                <span>How are updates secured?</span>
                <span>What if a service crashes?</span>
              </div>
            </div>
          </section>

          <section className="meet-creator__section meet-creator__timeline-section" aria-labelledby="timeline-title">
            <SectionHeading number="07" eyebrow="A work in progress" title="Timeline" id="timeline-title" />
            <div className="meet-creator__timeline" role="list">
              {TIMELINE.map((entry) => (
                <div className="meet-creator__timeline-item" role="listitem" key={entry.year}>
                  <span className="meet-creator__timeline-dot" aria-hidden="true" />
                  <span className="meet-creator__timeline-year">{entry.year}</span>
                  <span className="meet-creator__timeline-label">{entry.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="meet-creator__belief-card" aria-labelledby="belief-title">
            <div className="meet-creator__belief-quote" aria-hidden="true">“</div>
            <div>
              <p className="meet-creator__section-kicker"><span>08</span>THE PRINCIPLE</p>
              <h2 id="belief-title">What I <span>Believe</span></h2>
              <blockquote>Good engineering is not just making features work. It is understanding the entire system — how it behaves, how it fails, and how to make it better.</blockquote>
            </div>
          </section>

          <section className="meet-creator__cta" aria-labelledby="cta-title">
            <p className="meet-creator__eyebrow"><span className="meet-creator__eyebrow-mark" />The next move</p>
            <h2 id="cta-title">Want to See What Happens <span>Behind the Chessboard?</span></h2>
            <p>Explore the architecture, technology, and engineering decisions that power the platform.</p>
            <Button variant="primary" onClick={scrollToEngineering}>
              Explore the Engineering <span aria-hidden="true">→</span>
            </Button>
          </section>
        </div>
      </main>

      <footer className="meet-creator__footer meet-creator__shell">
        <a href="/" className="meet-creator__footer-link"><span aria-hidden="true">←</span> Back to Chess</a>
        <span>Built with intention by Momen Lotfy</span>
      </footer>
    </div>
  );
}
