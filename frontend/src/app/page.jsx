'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { HiArrowRight, HiArrowDown } from 'react-icons/hi2';
import Brand from '../components/Brand';
import NexusStage from '../components/nexus/NexusStage';
import { nodeById } from '../components/nexus/nexusConfig';
import { useScrollProgress } from '../hooks/useScrollProgress';
import { useReveal } from '../hooks/useReveal';

// Public story: Commerce data → Nexus intelligence → Better decisions.
// Copy speaks in outcomes and ideas; it never names internal modules.

const CHAPTERS = [
  { id: 'top', label: 'Overview' },
  { id: 'data', label: 'Your data' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'clarity', label: 'Clarity' },
];

const OUTCOMES = [
  { id: 'signals', title: 'Notice change early', text: 'Shifts in your business surface while there is still time to respond.' },
  { id: 'risks', title: 'See problems before they grow', text: 'Small warning signs are raised before they turn into lost sales.' },
  { id: 'opportunities', title: 'Find your next gain', text: 'Moments worth acting on stand out from the everyday noise.' },
];

const QUESTIONS = [
  'What needs my attention today?',
  'What changed in my business?',
  'What is likely to happen next?',
  'Where could I be losing sales?',
  'What should I act on first?',
];

function OutcomeRow({ item, hovered, onHover }) {
  const node = nodeById(item.id);
  return (
    <li
      className={`outcome ${hovered === item.id ? 'is-active' : ''}`}
      style={{ '--tone': node.color }}
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="outcome-dot" aria-hidden="true" />
      <div>
        <h3>{item.title}</h3>
        <p>{item.text}</p>
      </div>
    </li>
  );
}

export default function LandingPage() {
  const pageRef = useRef(null);
  const storyRef = useRef(null);
  const { progressRef, chapter } = useScrollProgress(storyRef, CHAPTERS.length);
  const [hovered, setHovered] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  useReveal(pageRef);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="site" ref={pageRef}>
      <nav className={`site-nav ${scrolled ? 'is-scrolled' : ''}`} aria-label="Main navigation">
        <Brand />
        <div className="site-nav-links">
          <a href="#chapter-data">How it works</a>
          <a href="#questions">Why NexusCommerce</a>
        </div>
        <div className="site-nav-actions">
          <Link href="/login" className="site-nav-signin">Sign in</Link>
          <Link href="/signup" className="btn-primary btn-sm">Open workspace</Link>
        </div>
      </nav>

      <main id="main-content">
        {/* ── Story: chapters scroll beside a pinned Nexus ──────────────── */}
        <section className="story" ref={storyRef} aria-label="How NexusCommerce turns data into decisions">
          <div className="story-stage">
            <NexusStage variant="hero" progressRef={progressRef} hovered={hovered} onHover={setHovered} />
            <div className="story-scrim" aria-hidden="true" />
            <ol className="story-rail" aria-hidden="true">
              {CHAPTERS.map((c, i) => (
                <li key={c.id} className={chapter === i ? 'is-current' : chapter > i ? 'is-past' : ''}><span>{c.label}</span></li>
              ))}
            </ol>
            <div className="story-meter" aria-hidden="true"><span /></div>
          </div>

          <div className="story-chapters">
            <div className="chapter chapter-hero" id="chapter-top">
              <div className="chapter-copy">
                <p className="chapter-kicker">Commerce intelligence for online sellers</p>
                <h1 className="hero-title">Turn your sales data into your next decision.</h1>
                <p className="hero-lede">NexusCommerce brings your store’s data together and turns it into clear, timely guidance — so you always know where to focus.</p>
                <div className="hero-actions">
                  <Link href="/signup" className="btn-primary btn-lg">Open your workspace <HiArrowRight /></Link>
                  <a href="#chapter-data" className="btn-secondary btn-lg">See how it works <HiArrowDown /></a>
                </div>
              </div>
            </div>

            <div className="chapter" id="chapter-data">
              <div className="chapter-copy">
                <p className="chapter-kicker"><span className="chapter-num">01</span>Commerce data</p>
                <h2 className="chapter-title">Your store already knows more than you think.</h2>
                <p className="chapter-text">Every order, product and stock level holds a small piece of the story. NexusCommerce brings those pieces together into one view you can trust.</p>
              </div>
            </div>

            <div className="chapter" id="chapter-intelligence">
              <div className="chapter-copy">
                <p className="chapter-kicker"><span className="chapter-num">02</span>Nexus intelligence</p>
                <h2 className="chapter-title">Patterns become understanding.</h2>
                <p className="chapter-text">It learns the rhythm of your business — what is normal, what is changing, and what tends to come next — and keeps learning as you grow.</p>
              </div>
            </div>

            <div className="chapter" id="chapter-decisions">
              <div className="chapter-copy">
                <p className="chapter-kicker"><span className="chapter-num">03</span>Better decisions</p>
                <h2 className="chapter-title">Know where to act first.</h2>
                <ul className="outcomes">
                  {OUTCOMES.map(o => <OutcomeRow key={o.id} item={o} hovered={hovered} onHover={setHovered} />)}
                </ul>
              </div>
            </div>

            <div className="chapter" id="chapter-clarity">
              <div className="chapter-copy">
                <p className="chapter-kicker"><span className="chapter-num">04</span>Clarity</p>
                <h2 className="chapter-title">One clear view of your business.</h2>
                <p className="chapter-text">Less time searching through spreadsheets, more time making the decisions that move your store forward.</p>
                <div className="hero-actions">
                  <Link href="/signup" className="btn-primary btn-lg">Get started <HiArrowRight /></Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── The questions every seller carries ─────────────────────────── */}
        <section className="section questions" id="questions" aria-labelledby="questions-title">
          <div className="questions-intro" data-reveal>
            <p className="section-kicker">Why NexusCommerce</p>
            <h2 id="questions-title" className="section-title">Running a store means answering the same questions every day.</h2>
            <p className="section-text">NexusCommerce helps you answer them with confidence — and quickly enough to act.</p>
          </div>
          <ol className="question-list">
            {QUESTIONS.map((q, i) => (
              <li key={q} data-reveal style={{ '--delay': `${i * 0.06}s` }}>
                <span className="question-index" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <span className="question-text">{q}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Workspace glimpse: signal → interpretation → action ───────── */}
        <section className="section glimpse" aria-labelledby="glimpse-title">
          <div className="glimpse-intro" data-reveal>
            <p className="section-kicker">Inside the workspace</p>
            <h2 id="glimpse-title" className="section-title">From a signal to a clear next step.</h2>
            <p className="section-text">Instead of more charts to read, you get the change that matters, what it likely means, and what to do about it.</p>
          </div>

          <div className="glimpse-frame" data-reveal aria-label="Illustrative example of a NexusCommerce insight">
            <div className="glimpse-bar">
              <span className="glimpse-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="glimpse-title">Needs your attention</span>
              <span className="status status-neutral">Illustrative example</span>
            </div>
            <div className="glimpse-body">
              <div className="glimpse-step" style={{ '--tone': 'var(--warning)' }}>
                <p className="glimpse-label">Signal</p>
                <p className="glimpse-head">Weekend sales of a best-seller fell 18%</p>
                <svg className="glimpse-spark" viewBox="0 0 220 56" aria-hidden="true">
                  <polyline points="0,30 22,26 44,28 66,18 88,22 110,14 132,20 154,16 176,34 198,42 220,40" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  <line x1="166" y1="4" x2="166" y2="54" stroke="var(--border-strong)" strokeDasharray="3 3" />
                </svg>
              </div>
              <div className="glimpse-arrow" aria-hidden="true"><HiArrowRight /></div>
              <div className="glimpse-step" style={{ '--tone': 'var(--accent)' }}>
                <p className="glimpse-label">What it likely means</p>
                <p className="glimpse-head">Stock ran short before the weekend rush</p>
                <p className="glimpse-text">Demand held steady — the shelf simply emptied too early.</p>
              </div>
              <div className="glimpse-arrow" aria-hidden="true"><HiArrowRight /></div>
              <div className="glimpse-step" style={{ '--tone': 'var(--success)' }}>
                <p className="glimpse-label">Suggested next step</p>
                <p className="glimpse-head">Restock a few days earlier next week</p>
                <span className="btn-primary btn-sm glimpse-cta" aria-hidden="true">Plan restock <HiArrowRight /></span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Closing ───────────────────────────────────────────────────── */}
        <section className="closing" aria-labelledby="closing-title">
          <div className="closing-inner" data-reveal>
            <h2 id="closing-title" className="closing-title">See your business clearly. Decide with confidence.</h2>
            <p className="section-text">Start with the data you already have.</p>
            <div className="hero-actions closing-actions">
              <Link href="/signup" className="btn-primary btn-lg">Open your workspace <HiArrowRight /></Link>
              <Link href="/login" className="btn-secondary btn-lg">Sign in</Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <Brand />
        <p>Commerce data, turned into better decisions.</p>
        <p>© {new Date().getFullYear()} NexusCommerce</p>
      </footer>
    </div>
  );
}
