import {
  buildBugReportUrl,
  buildFeatureRequestUrl,
  DISCUSSIONS_QA_URL,
} from './feedbackLinks';

const originalVersion = process.env.REACT_APP_VERSION;

afterEach(() => {
  if (originalVersion === undefined) {
    delete process.env.REACT_APP_VERSION;
  } else {
    process.env.REACT_APP_VERSION = originalVersion;
  }
});

describe('feedback links', () => {
  test('builds an encoded bug report URL with app context and deployment', () => {
    process.env.REACT_APP_VERSION = 'build 42/alpha';

    const result = buildBugReportUrl('/v2/pods/research & design');

    expect(result).toBe(
      'https://github.com/Team-Commonly/commonly/issues/new?template=bug_report.yml'
      + '&app_context=build+42%2Falpha+%40+%2Fv2%2Fpods%2Fresearch+%26+design'
      + '&deployment=Commonly+hosted+%28commonly.me%29',
    );
    const url = new URL(result);
    expect(url.searchParams.get('app_context')).toBe('build 42/alpha @ /v2/pods/research & design');
    expect(url.searchParams.get('deployment')).toBe('Commonly hosted (commonly.me)');
  });

  test('uses dev when the build version is unavailable', () => {
    delete process.env.REACT_APP_VERSION;

    const url = new URL(buildBugReportUrl('/v2/settings'));

    expect(url.searchParams.get('app_context')).toBe('dev @ /v2/settings');
  });

  test('builds the feature request and Discussions Q&A URLs', () => {
    expect(buildFeatureRequestUrl()).toBe(
      'https://github.com/Team-Commonly/commonly/issues/new?template=feature_request.yml',
    );
    expect(DISCUSSIONS_QA_URL).toBe(
      'https://github.com/Team-Commonly/commonly/discussions/new?category=q-a',
    );
  });
});
