// @ts-nocheck
import fs from 'fs';
import path from 'path';
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useV2Confirm } from './useV2Confirm';

const Harness = ({ ask = 'confirm', onSubmit = () => {} }) => {
  const { confirm, prompt, dialog } = useV2Confirm();
  const [result, setResult] = useState('none');
  const run = async () => {
    const options = { message: 'Revoke laptop?', confirmLabel: 'Revoke' };
    setResult(String(ask === 'confirm' ? await confirm(options) : await prompt(options)));
  };
  return (
    <form onSubmit={onSubmit}>
      <button type="button" onClick={() => { void run(); }}>Open</button>
      <output>{result}</output>
      {dialog}
    </form>
  );
};

const open = () => {
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  return screen.getByRole('alertdialog', { name: 'Revoke laptop?' });
};

test('the dialog resolves true on its action and puts focus back', async () => {
  render(<Harness />);
  const dialog = open();
  expect(document.body).toContainElement(dialog);
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
});

test.each([
  ['Cancel', (dialog) => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))],
  ['Escape', (dialog) => fireEvent.keyDown(dialog, { key: 'Escape' })],
  ['the backdrop', (dialog) => fireEvent.click(dialog.parentElement)],
])('%s resolves false', async (_, dismiss) => {
  render(<Harness />);
  dismiss(open());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('Escape stops at the dialog, because the app blurs on any Escape that reaches the document', () => {
  render(<Harness />);
  const heard = jest.fn();
  document.addEventListener('keydown', heard);
  fireEvent.keyDown(open(), { key: 'Escape' });
  document.removeEventListener('keydown', heard);
  expect(heard).not.toHaveBeenCalled();
});

test('Escape during text composition leaves the dialog open', () => {
  render(<Harness ask="prompt" />);
  const dialog = open();
  fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Escape', isComposing: true });
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
});

test('a new subject cancels the question about the old one', async () => {
  const seen = jest.fn();
  const Page = ({ subject }) => {
    const { confirm, dialog } = useV2Confirm(subject);
    return (
      <>
        <button type="button" onClick={() => { void confirm({ message: 'Sure?', confirmLabel: 'Yes' }).then(seen); }}>Open</button>
        {dialog}
      </>
    );
  };
  const { rerender } = render(<Page subject="a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  rerender(<Page subject="a" />);
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  rerender(<Page subject="b" />);
  await waitFor(() => expect(seen).toHaveBeenCalledWith(false));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('Tab stays inside the dialog', () => {
  render(<Harness />);
  const dialog = open();
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  const action = within(dialog).getByRole('button', { name: 'Revoke' });
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
  expect(action).toHaveFocus();
  fireEvent.keyDown(action, { key: 'Tab' });
  expect(cancel).toHaveFocus();
});

test('Escape and Tab still work once focus has left the dialog', async () => {
  render(<Harness />);
  const dialog = open();
  document.activeElement.blur();
  fireEvent.keyDown(document.body, { key: 'Tab' });
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

  document.activeElement.blur();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('false'));
});

test('a prompt returns the text, an empty answer included, and null on cancel', async () => {
  render(<Harness ask="prompt" />);
  let dialog = open();
  const input = within(dialog).getByRole('textbox', { name: 'Revoke laptop?' });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'spam' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('spam'));

  dialog = open();
  expect(within(dialog).getByRole('textbox')).toHaveValue('');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement());

  fireEvent.keyDown(open(), { key: 'Escape' });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('null'));
});

test('a submit in the dialog never reaches a form that renders it', async () => {
  const onSubmit = jest.fn((event) => event.preventDefault());
  render(<Harness onSubmit={onSubmit} />);
  fireEvent.click(within(open()).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('true'));
  expect(onSubmit).not.toHaveBeenCalled();
});

test('leaving the page answers the dialog as a cancel', async () => {
  const seen = jest.fn();
  const Page = () => {
    const { confirm, dialog } = useV2Confirm();
    return (
      <>
        <button type="button" onClick={() => { void confirm({ message: 'Sure?', confirmLabel: 'Yes' }).then(seen); }}>Open</button>
        {dialog}
      </>
    );
  };
  const { unmount } = render(<Page />);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  unmount();
  await waitFor(() => expect(seen).toHaveBeenCalledWith(false));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('no v2 surface goes back to a native browser dialog', () => {
  const root = path.resolve(__dirname, '..');
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
  const used = files(root).filter((file) => /window\.(confirm|prompt|alert)\(/.test(fs.readFileSync(file, 'utf8')));
  expect(used).toEqual([]);
});
