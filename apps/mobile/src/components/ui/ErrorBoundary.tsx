import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { errorMessage, useT } from '@/i18n';
import { EmptyState } from './EmptyState';
import { Button } from './Button';

interface Props {
  children: React.ReactNode;
  /** Custom fallback renderer. */
  fallback?: (error: unknown, reset: () => void) => React.ReactNode;
  onError?: (error: unknown) => void;
}

interface State {
  error: unknown;
  failed: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[ErrorBoundary]', error);
    this.props.onError?.(error);
  }

  reset = () => this.setState({ error: null, failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return <DefaultFallback error={this.state.error} reset={this.reset} />;
  }
}

function DefaultFallback({ error, reset }: { error: unknown; reset: () => void }) {
  const { colors: c } = useTheme();
  const { t } = useT();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
      <EmptyState icon="warning" title={t('errors.title')} body={errorMessage(t, error)} />
      <Button label={t('common.retry')} icon="sync" onPress={reset} />
    </View>
  );
}
