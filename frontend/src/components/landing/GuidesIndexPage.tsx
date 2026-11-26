import React from 'react';
import { useNavigate } from 'react-router-dom';
import guides from '../../content/guides.json';
import { ForwardArrow, GuideTop, useGuideCanvas } from './guideShell';

interface Guide {
  eyebrow: string;
  title: string;
  summary: string;
}

const GUIDES = guides as Record<string, Guide>;

const GuidesIndexPage: React.FC = () => {
  const navigate = useNavigate();
  useGuideCanvas();

  return (
    <div className="guide-page">
      <div className="guide-container">
        <GuideTop onBack={() => navigate('/')} />

        <p className="guide-eyebrow">GUIDES</p>
        <h1 className="guide-title">Guides for teams working with AI agents</h1>
        <p className="guide-lede">
          Practical explanations of the shared context, ownership, and handoffs that help people and AI agents work together on real projects.
        </p>

        <div className="guide-cards">
          {Object.entries(GUIDES).map(([id, guide]) => (
            <article className="guide-card" key={id}>
              <p className="guide-eyebrow">{guide.eyebrow.toUpperCase()}</p>
              <h2 className="guide-h2">{guide.title}</h2>
              <p>{guide.summary}</p>
              <button type="button" className="guide-btn" onClick={() => navigate(`/guides/${id}/`)}>
                Read the guide
                <ForwardArrow />
              </button>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
};

export default GuidesIndexPage;
