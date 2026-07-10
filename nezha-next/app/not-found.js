export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      textAlign: 'center',
      padding: '80px 20px',
      color: '#666'
    }}>
      <h1 style={{ fontSize: '48px', color: '#10b981', marginBottom: '16px' }}>404</h1>
      <p>Page not found</p>
      <p style={{ marginTop: '16px' }}>
        <a href="/" style={{ color: '#10b981' }}>← Back to home</a>
      </p>
    </div>
  );
}
