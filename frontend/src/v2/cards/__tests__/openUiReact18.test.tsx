import React from 'react';
import { render, screen } from '@testing-library/react';
import { createLibrary, defineComponent, Renderer } from '@openuidev/react-lang';
import { z } from 'zod/v4';

// Exercise the real package: its README requests React 19 while Commonly uses 18.
test('renders a static OpenUI card with the installed React 18 runtime', () => {
  expect(React.version).toMatch(/^18\./);
  const Text = defineComponent({
    name: 'Text', description: 'Plain message text',
    props: z.object({ body: z.string() }),
    component: ({ props }) => <p>{props.body}</p>,
  });
  const library = createLibrary({ components: [Text], root: 'Text' });
  render(<Renderer response={'root = Text("Card on React 18")'} library={library} publishObservability={false} />);
  expect(screen.getByText('Card on React 18')).toBeInTheDocument();
  expect(document.querySelector('[data-openui-devtools-auto-mount]')).toBeNull();
});
