import React, { useRef, useState } from 'react';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import '../../i18n';
import V2AvatarCropDialog from '../components/V2AvatarCropDialog';

const selectedFile = new File(['original'], 'original.jpg', { type: 'image/jpeg' });

describe('V2AvatarCropDialog', () => {
  let image: HTMLImageElement;
  let drawImage: jest.Mock;
  let previousImageDescriptor: PropertyDescriptor | undefined;
  let previousPointerEventDescriptor: PropertyDescriptor | undefined;
  let previousCreateObjectURLDescriptor: PropertyDescriptor | undefined;
  let previousRevokeObjectURLDescriptor: PropertyDescriptor | undefined;
  let previousGetContextDescriptor: PropertyDescriptor | undefined;
  let previousToDataURLDescriptor: PropertyDescriptor | undefined;
  let previousToBlobDescriptor: PropertyDescriptor | undefined;
  let createElementSpy: jest.SpyInstance | null = null;

  beforeAll(() => {
    previousImageDescriptor = Object.getOwnPropertyDescriptor(window, 'Image');
    previousPointerEventDescriptor = Object.getOwnPropertyDescriptor(window, 'PointerEvent');
    previousCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    previousRevokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    previousGetContextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
    previousToDataURLDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toDataURL');
    previousToBlobDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob');
  });

  beforeEach(() => {
    image = document.createElement('img');
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1600 },
      naturalHeight: { configurable: true, value: 900 },
    });
    drawImage = jest.fn();
    const context = {
      drawImage,
      clearRect: jest.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    } as unknown as CanvasRenderingContext2D;

    Object.defineProperty(window, 'Image', { configurable: true, value: jest.fn(() => image) });
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: class TestPointerEvent extends MouseEvent {
        pointerId: number;

        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId || 0;
        }
      },
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:avatar') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: jest.fn(() => context),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
      configurable: true,
      value: jest.fn(() => 'data:image/png;base64,preview'),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: jest.fn((callback: BlobCallback) => callback(new Blob(['cropped'], { type: 'image/png' }))),
    });
  });

  afterAll(() => {
    const restore = (target: object, key: PropertyKey, descriptor?: PropertyDescriptor) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete (target as Record<PropertyKey, unknown>)[key];
    };
    restore(window, 'Image', previousImageDescriptor);
    restore(window, 'PointerEvent', previousPointerEventDescriptor);
    restore(URL, 'createObjectURL', previousCreateObjectURLDescriptor);
    restore(URL, 'revokeObjectURL', previousRevokeObjectURLDescriptor);
    restore(HTMLCanvasElement.prototype, 'getContext', previousGetContextDescriptor);
    restore(HTMLCanvasElement.prototype, 'toDataURL', previousToDataURLDescriptor);
    restore(HTMLCanvasElement.prototype, 'toBlob', previousToBlobDescriptor);
  });

  afterEach(() => {
    createElementSpy?.mockRestore();
    createElementSpy = null;
  });

  test('keeps a square preview and the zoomed crop can be saved as PNG', async () => {
    const onSave = jest.fn();
    const createdCanvases: HTMLCanvasElement[] = [];
    const originalCreateElement = document.createElement.bind(document);
    createElementSpy = jest.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName === 'canvas') createdCanvases.push(element as HTMLCanvasElement);
      return element;
    }) as typeof document.createElement);
    render(
      <V2AvatarCropDialog
        file={selectedFile}
        saving={false}
        error={null}
        onCancel={jest.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Upload photo' })).toBeInTheDocument();
    act(() => { image.onload?.call(image, new Event('load')); });
    expect(await screen.findByLabelText('Avatar crop preview')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveAttribute('min', '1');
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('1');
    expect(document.querySelector('.v2-settings__avatar-crop-frame')).toBeInTheDocument();
    expect(document.querySelectorAll('.v2-settings__avatar-preview-image')).toHaveLength(3);
    const initialImage = drawImage.mock.calls[0];
    expect(initialImage[0]).toBe(image);
    expect(initialImage[1]).toBeCloseTo((392 - 150.8) / 2 - (350 * 150.8) / 900);
    expect(initialImage[2]).toBeCloseTo((260 - 150.8) / 2);
    expect(initialImage[3]).toBeCloseTo((1600 * 150.8) / 900);
    expect(initialImage[4]).toBeCloseTo(150.8);
    expect(drawImage.mock.calls[1]).toEqual([image, 350, 0, 900, 900, 0, 0, 64, 64]);

    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '2' } });
    expect(drawImage).toHaveBeenLastCalledWith(image, 575, 225, 450, 450, 0, 0, 64, 64);
    fireEvent.click(screen.getByRole('button', { name: 'Save photo' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' })));
    expect((document.querySelector('canvas') as HTMLCanvasElement).width).toBe(392);
    expect(createdCanvases.map((canvas) => canvas.width)).toContain(512);
  });

  test('Escape cancels and restores focus to the upload control', () => {
    const onCancel = jest.fn();
    const Wrapper = () => {
      const [open, setOpen] = useState(false);
      const uploadButtonRef = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={uploadButtonRef} type="button" onClick={() => setOpen(true)}>Upload photo</button>
          {open && (
            <V2AvatarCropDialog
              file={selectedFile}
              saving={false}
              error={null}
              returnFocusElement={uploadButtonRef.current}
              onCancel={() => { onCancel(); setOpen(false); }}
              onSave={jest.fn()}
            />
          )}
        </>
      );
    };
    render(<Wrapper />);
    const uploadButton = screen.getByRole('button', { name: 'Upload photo' });
    uploadButton.focus();
    fireEvent.click(uploadButton);

    const reachedDocument = jest.fn();
    document.addEventListener('keydown', reachedDocument);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Upload photo' }), { key: 'Escape' });
    document.removeEventListener('keydown', reachedDocument);

    // Escape must not reach App.tsx's setupFocusManagement, which would blur the restored focus.
    expect(reachedDocument).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(uploadButton).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  test('keeps Save photo focusable and ignores activation while saving', async () => {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    const { rerender } = render(
      <V2AvatarCropDialog
        file={selectedFile}
        saving={false}
        error={null}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    act(() => { image.onload?.call(image, new Event('load')); });
    const saveButton = await screen.findByRole('button', { name: 'Save photo' });
    saveButton.focus();

    rerender(
      <V2AvatarCropDialog
        file={selectedFile}
        saving
        error={null}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    const savingButton = screen.getByRole('button', { name: 'Saving…' });
    expect(savingButton).toHaveAttribute('aria-disabled', 'true');
    expect(savingButton).not.toBeDisabled();
    expect(savingButton).toHaveFocus();

    fireEvent.click(savingButton);
    expect(onSave).not.toHaveBeenCalled();
    expect(savingButton).toHaveFocus();
  });

  test('dragging the source image changes the square crop', () => {
    render(
      <V2AvatarCropDialog
        file={selectedFile}
        saving={false}
        error={null}
        onCancel={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    act(() => { image.onload?.call(image, new Event('load')); });
    const canvas = screen.getByLabelText('Avatar crop preview') as HTMLCanvasElement;
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0, y: 0, top: 0, left: 0, right: 392, bottom: 260, width: 392, height: 260,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 180, clientY: 180 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 200, clientY: 180 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 200, clientY: 180 });

    const crop = drawImage.mock.calls[drawImage.mock.calls.length - 1];
    expect(crop[0]).toBe(image);
    expect(crop[1]).toBeCloseTo(350 - (20 * 900) / 150.8);
    expect(crop[2]).toBeCloseTo(0);
    expect(crop[3]).toBeCloseTo(900);
    expect(crop[4]).toBeCloseTo(900);
  });
});
