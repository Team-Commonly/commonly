import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useCases from '../../content/use-cases.json';
import { ForwardArrow, GuideTop, useGuideCanvas } from './guideShell';

interface UseCase {
  eyebrow: string;
  title: string;
  summary: string;
  problems: string[];
  outcomes: string[];
  exampleFlow: string[];
  relatedGuides?: Array<{ title: string; path: string }>;
}

const USE_CASES = useCases as Record<string, UseCase>;

// Shares the guide pages' light shell, as the pre-rendered use-case page does.
const UseCasePage: React.FC = () => {
  const { useCaseId } = useParams<{ useCaseId: string }>();
  const navigate = useNavigate();
  const useCase = useCaseId ? USE_CASES[useCaseId] : undefined;

  useGuideCanvas();

  if (!useCase) {
    return (
      <div className="guide-page guide-page--missing">
        <div className="guide-container">
          <GuideTop onBack={() => navigate('/')} />
          <h1 className="guide-missing-title">Use case not found</h1>
          <p className="guide-lede">This page does not exist yet. Return to landing and choose another use case.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="guide-page">
      <div className="guide-container">
        <GuideTop onBack={() => navigate('/')} />

        <p className="guide-eyebrow">{useCase.eyebrow.toUpperCase()}</p>
        <h1 className="guide-title">{useCase.title}</h1>
        <p className="guide-lede">{useCase.summary}</p>

        <div className="guide-split">
          <section className="guide-card">
            <h2 className="guide-h3">Common challenges</h2>
            <ul>{useCase.problems.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section className="guide-card guide-card--accent">
            <h2 className="guide-h3">What you can do</h2>
            <ul>{useCase.outcomes.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        </div>

        <section className="guide-card guide-block">
          <h2 className="guide-h3">Example flow</h2>
          <ol>{useCase.exampleFlow.map((step) => <li key={step}>{step}</li>)}</ol>
        </section>

        {useCase.relatedGuides && useCase.relatedGuides.length > 0 && (
          <section className="guide-card guide-card--accent guide-block">
            <h2 className="guide-h3">Related guides</h2>
            <div className="guide-actions guide-actions--stack">
              {useCase.relatedGuides.map((guide) => (
                <button type="button" key={guide.path} className="guide-btn" onClick={() => navigate(guide.path)}>{guide.title}</button>
              ))}
            </div>
          </section>
        )}

        <hr className="guide-rule" />

        <div className="guide-actions">
          <button type="button" className="guide-btn guide-btn--filled" onClick={() => navigate('/register')}>
            Start with this use case
            <ForwardArrow />
          </button>
          <button type="button" className="guide-btn guide-btn--outlined" onClick={() => navigate('/agents')}>
            Explore Agent Hub
          </button>
        </div>
      </div>
    </div>
  );
};

export default UseCasePage;
