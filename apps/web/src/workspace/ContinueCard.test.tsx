// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { ContinueCard } from './ContinueCard.js';

describe('the continue card', () => {
  it('renders nothing when there is no stored position', () => {
    const { container } = render(<ContinueCard position={undefined} dropped={[]} titleOf={() => 'Sunday'} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the service itself was dropped', () => {
    const { container } = render(
      <ContinueCard position={undefined} dropped={['serviceId']} titleOf={() => 'Sunday'} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders nothing when it cannot find a title for the service', () => {
    const { container } = render(
      <ContinueCard position={{ serviceId: 's1' }} dropped={[]} titleOf={() => undefined} />,
    );
    expect(container.textContent).toBe('');
  });

  it('links to the service with the item preserved when it survived', () => {
    render(
      <ContinueCard position={{ serviceId: 's1', itemId: 'item-1' }} dropped={[]} titleOf={() => 'Sunday'} />,
    );

    expect(screen.getByRole('link', { name: 'Open Sunday' }).getAttribute('href')).toBe('/services/s1?item=item-1');
    expect(screen.queryByText('The item you were last viewing is no longer available.')).toBeNull();
  });

  it('drops the item from the link and shows a notice when it is no longer available', () => {
    render(
      <ContinueCard position={{ serviceId: 's1', itemId: 'item-1' }} dropped={['itemId']} titleOf={() => 'Sunday'} />,
    );

    expect(screen.getByRole('link', { name: 'Open Sunday' }).getAttribute('href')).toBe('/services/s1');
    expect(screen.getByText('The item you were last viewing is no longer available.')).toBeTruthy();
  });

  it('shows the dropped notice for a slide that no longer survived', () => {
    render(
      <ContinueCard position={{ serviceId: 's1' }} dropped={['slideId']} titleOf={() => 'Sunday'} />,
    );

    expect(screen.getByText('The item you were last viewing is no longer available.')).toBeTruthy();
  });
});
