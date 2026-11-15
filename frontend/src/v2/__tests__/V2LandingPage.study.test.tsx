import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import V2LandingPage from '../landing/V2LandingPage';
import en from '../../i18n/locales/en.json';
import zh from '../../i18n/locales/zh-CN.json';

jest.mock('axios');
jest.mock('../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;
const STUDY_URL = 'https://alignment.anthropic.com/2026/worse-together';

describe('V2LandingPage research section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    mockAxiosGet.mockResolvedValue({ data: {} });
  });

  it('states the study first, then what the pod does, and links the study', () => {
    render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    const section = within(screen.getByTestId('landing-study'));
    expect(section.getByRole('heading', { level: 2, name: en.landing.study.title })).toBeInTheDocument();
    const paragraphs = screen.getByTestId('landing-study').querySelectorAll('p.v2-landing__sub');
    expect(paragraphs[0]).toHaveTextContent(/Worse Together/);
    expect(paragraphs[1]).toHaveTextContent(/A pod has a guard of that kind/);
    // The guard is on the CAP send route, so the copy names the agents it covers.
    expect(paragraphs[1]).toHaveTextContent(/for the agents you connect yourself: Claude Code, Codex on a Mac or another MCP client/);
    const link = section.getByRole('link', { name: en.landing.study.link });
    expect(link).toHaveAttribute('href', STUDY_URL);
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('keeps the claim inside its limits in both languages', () => {
    for (const copy of [en.landing.study, zh.landing.study, en.compare.study, zh.compare.study]) {
      const text = Object.values(copy).join(' ');
      // The guard was the best fix in one test, not overall; the override stays stated.
      expect(text).not.toMatch(/\b(the|our) (only|first)\b|\bonly (tool|platform|workspace|place|one)\b|\bany agent\b|唯一|首个|第一个/i);
    }
    expect(en.landing.study.study).toMatch(/In the group-order test/);
    expect(en.landing.study.pod).toMatch(/choose to send anyway/);
    expect(zh.landing.study.study).toMatch(/团体下单的测试/);
    expect(zh.landing.study.pod).toMatch(/照样发送/);
    expect(Object.keys(zh.landing.study)).toEqual(Object.keys(en.landing.study));
    expect(Object.keys(zh.compare.study)).toEqual(Object.keys(en.compare.study));
    // The hub carries the same block; it must not drift from the landing copy.
    for (const copy of [en, zh]) {
      const { kicker, ...landing } = copy.landing.study;
      expect(copy.compare.study).toEqual(landing);
    }
    expect(en.landing.study.pod).toMatch(/doesn't go through yet/);
    expect(en.landing.study.pod).not.toMatch(/come back to it/);
  });
});
