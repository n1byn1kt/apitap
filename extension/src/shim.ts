// Browser-compatible replacement for Buffer.from(str, 'base64').toString('utf-8')
// Used by entropy.ts and oauth-detector.ts

declare global {
  // eslint-disable-next-line no-var
  var Buffer: {
    from(str: string, encoding?: string): { toString(enc?: string): string };
  };
}

globalThis.Buffer = {
  from(str: string, encoding?: string) {
    return {
      toString(_enc?: string): string {
        if (encoding === 'base64') {
          const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
          try {
            return atob(normalized);
          } catch {
            return '';
          }
        }
        return str;
      },
    };
  },
};
