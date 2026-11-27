import React from 'react';
import { reportClientError } from '../utils/errorReporter';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'خطای غیرمنتظره‌ای در رابط کاربری رخ داد.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    void reportClientError({
      moduleOrFile: 'sentra-client/src/components/ErrorBoundary.tsx',
      actionOrRoute: 'react_render_crash',
      error,
      context: {
        component_stack: (info.componentStack || '').slice(0, 600),
      },
    });
  }

  private handleReload = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        dir="rtl"
        className="min-h-screen w-full flex items-center justify-center bg-slate-950 text-slate-100 p-6"
      >
        <div className="max-w-md w-full rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl space-y-4 text-center">
          <div className="text-3xl">⚠️</div>
          <h1 className="text-lg font-bold text-white">
            خطای غیرمنتظره در برنامه
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            گزارش فنی این خطا به‌صورت خودکار برای تیم پشتیبانی SentraVPN ارسال شد.
            برای ادامه، برنامه را مجدداً بارگذاری کنید.
          </p>
          {this.state.errorMessage ? (
            <p className="text-xs text-rose-300 bg-rose-950/50 border border-rose-900/60 rounded-lg p-2.5 break-words font-mono" dir="ltr">
              {this.state.errorMessage}
            </p>
          ) : null}
          <button
            type="button"
            onClick={this.handleReload}
            className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold py-2.5 px-4 transition-colors cursor-pointer"
          >
            بارگذاری مجدد برنامه
          </button>
        </div>
      </div>
    );
  }
}
