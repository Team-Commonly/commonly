import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import DemoWorkspace from '../DemoWorkspace';

/**
 * The landing hero demo (TASK-147). These pin behaviour, not markup: the
 * scripted replies arrive on a timer, the decision card settles into the
 * product's ruled state, and each pod keeps its own history.
 */

const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

const message = (text: string) => screen.getByText(text);

// A pod can carry the needs-you count, so its accessible name is "Launch" or
// "Launch1" depending on state. Matching either is deliberate: several tests
// below use that difference.
const podButton = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\s*\\d*$`) });

describe('DemoWorkspace', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('opens on the Launch pod with a thread, a decision to rule, and the scripted disclosure', () => {
    const { container } = render(<DemoWorkspace />);

    // The demo announces itself as a sample in its own chrome. This line is
    // the one honesty requirement of the surface, so it is asserted here and
    // guarded for every layout in v2-layout-invariants.
    expect(message('sample workspace · replies are scripted')).toBeInTheDocument();
    expect(podButton('Launch')).toHaveAttribute('aria-current', 'true');

    // The thread, its header state and the two agents it names.
    expect(screen.getByRole('log')).toBeInTheDocument();
    expect(message('@wren the signup fix is green. Merge it, then tell me what broke in last night’s deploy.')).toBeInTheDocument();
    expect(message('#212 merged · deployed 09:21')).toBeInTheDocument();
    expect(message('● 1 agent working')).toBeInTheDocument();

    // The decision card, drawn with the product's own card classes.
    expect(container.querySelector('.v2-decision-card')).not.toBeNull();
    expect(message('Wren needs you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email them now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wait for Friday' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Other…' })).toBeInTheDocument();
    // The first option is the product's primary choice (filled), and the card
    // says which agent is asking — both are the real card's shape, which is
    // the whole reason the demo borrows its classes instead of drawing one.
    expect(screen.getByRole('button', { name: 'Email them now' }))
      .toHaveClass('v2-decision-card__choice--primary');
    expect(screen.getByRole('button', { name: 'Wait for Friday' }))
      .not.toHaveClass('v2-decision-card__choice--primary');

    // Inspector: agents, needs-you, board, channel.
    expect(message('agents in launch')).toBeInTheDocument();
    expect(message('TASK-32 Note to users')).toBeInTheDocument();
    expect(message('Telegram · Launch')).toBeInTheDocument();
  });

  it('rules the decision: Sam’s line, then the agent’s reply, and the pod settles', () => {
    render(<DemoWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'Email them now' }));

    // Sam's ruling is immediate; the agent only starts working afterwards.
    expect(message('Email them now.')).toBeInTheDocument();
    expect(screen.queryByText('Wren is working')).not.toBeInTheDocument();

    advance(300);
    expect(screen.getByText('Wren is working')).toBeInTheDocument();

    advance(900);
    expect(screen.queryByText('Wren is working')).not.toBeInTheDocument();
    expect(message('Sending from support@ now: one line and a link to the fix. I’ll post the open rate here tomorrow.')).toBeInTheDocument();

    // The card is spent, and the pod's "needs you" is answered in all three
    // places it was claimed: the inspector, the board row and the pod count.
    expect(screen.queryByRole('button', { name: 'Email them now' })).not.toBeInTheDocument();
    expect(message('Nothing. Your agents are working.')).toBeInTheDocument();
    expect(message('wren · wip')).toBeInTheDocument();
    expect(screen.queryByText('needs you', { selector: '.v2-demo__board-state' })).not.toBeInTheDocument();
    expect(message('working · note to users')).toBeInTheDocument();
    expect(podButton('Launch')).not.toHaveTextContent(/1/);
  });

  it('sends a suggested prompt as Sam and runs its whole scripted chain', () => {
    render(<DemoWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: '@kai is the retry fix up?' }));

    // The prompt is now a message from Sam, and the chip is used up.
    expect(message('@kai is the retry fix up?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '@kai is the retry fix up?' })).not.toBeInTheDocument();

    advance(500);
    expect(screen.getByText('Kai is working')).toBeInTheDocument();
    advance(900);
    expect(message('PR #214 is up with a test. Vera is reviewing it now.')).toBeInTheDocument();
    expect(message('#214 open · review requested')).toBeInTheDocument();

    // Second link in the chain: a different agent, later.
    advance(1000);
    expect(screen.getByText('Vera is working')).toBeInTheDocument();
    advance(900);
    expect(message('Reviewed #214. One nit, fixed in place. Approved.')).toBeInTheDocument();
  });

  it('answers free text from the pod’s lead agent, and ignores an empty send', () => {
    const { container } = render(<DemoWorkspace />);

    const input = screen.getByLabelText('Message Launch');
    fireEvent.change(input, { target: { value: 'what should I look at first?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(message('what should I look at first?')).toBeInTheDocument();
    advance(1500);
    expect(message('Noted. I’ll pick it up after the task I’m on and post here when it’s done.')).toBeInTheDocument();

    // An empty or whitespace-only send adds nothing: no blank row, no reply.
    const rows = () => container.querySelectorAll('.v2-demo__msg').length;
    const before = rows();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    advance(2000);
    expect(rows()).toBe(before);
  });

  it('keeps each pod’s own history and decision when you switch between them', () => {
    render(<DemoWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'Email them now' }));
    advance(1200);

    fireEvent.click(podButton('Support'));
    // Support has its own ask, its own agents and its own Slack channel.
    expect(message('Dana wants a CSV of the Launch pod. It has two private threads. Leave them out, or export everything?')).toBeInTheDocument();
    expect(message('Slack · #help')).toBeInTheDocument();
    expect(screen.queryByText('Sending from support@ now: one line and a link to the fix. I’ll post the open rate here tomorrow.')).not.toBeInTheDocument();
    // The count is per pod, not a global flag: Launch's ask is ruled and its
    // badge is gone, while Support's own ask is still open and still counted.
    expect(podButton('Launch')).not.toHaveTextContent('1');
    expect(podButton('Support')).toHaveTextContent('1');

    fireEvent.click(podButton('Launch'));
    // Coming back: the ruling and its reply are still there, the card is not.
    expect(message('Sending from support@ now: one line and a link to the fix. I’ll post the open rate here tomorrow.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email them now' })).not.toBeInTheDocument();
    expect(podButton('Launch')).toHaveAttribute('aria-current', 'true');
    // The draft belongs to the pod you were typing in, not the one you return to.
    expect(screen.getByLabelText('Message Launch')).toHaveValue('');
  });

  it('drops a queued reply when the visitor leaves the page', () => {
    const { unmount } = render(<DemoWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Email them now' }));
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();

    // Every scripted timer is cleared on unmount: nothing fires into a dead
    // tree, which on a landing page is a leak rather than a warning.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('draws faces from the real kit, never from the design canvas', () => {
    const { container } = render(<DemoWorkspace />);
    const faces = Array.from(container.querySelectorAll('img.v2-demo__face'));

    // The board's /_blob/… URLs do not resolve outside the canvas; the kit's
    // data URIs do. A single canvas URL here is a broken face on the landing.
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.every((face) => face.getAttribute('src')?.startsWith('data:image/svg+xml'))).toBe(true);

    // Dana has no face in the fixture — she is a customer, not a member, and
    // the spec draws her with an initial. That path has to exist too.
    fireEvent.click(podButton('Support'));
    expect(container.querySelectorAll('.v2-demo__face--initial').length).toBe(2);
  });

  it('names the pod switcher for assistive tech and marks the open pod', () => {
    render(<DemoWorkspace />);
    const strip = screen.getByRole('navigation', { name: 'Sample pods' });

    // Four pods, and exactly one is current.
    const pods = within(strip).getAllByRole('button');
    expect(pods.map((p) => p.textContent)).toEqual(['Launch1', 'Support1', 'Website', 'Growth']);
    expect(pods.filter((p) => p.getAttribute('aria-current') === 'true')).toHaveLength(1);
  });
});
