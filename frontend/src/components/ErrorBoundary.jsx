import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const msg = this.state.error?.message || '';
      const isWebGL = msg.toLowerCase().includes('webgl') || msg.toLowerCase().includes('context');
      return (
        <div className="flex items-center justify-center h-full bg-gray-50 p-8">
          <div className="max-w-md text-center">
            <div className="text-4xl mb-4">{isWebGL ? '🖥️' : '⚠️'}</div>
            <h2 className="text-lg font-bold text-slate-800 mb-2">
              {isWebGL ? 'WebGL Required' : 'Something went wrong'}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {isWebGL
                ? 'The map requires WebGL. Please use Chrome, Firefox, or Safari on a modern device.'
                : (this.props.fallback || 'An unexpected error occurred. Please refresh the page.')}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-700 transition"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
