export default function HomePage() {
  return (
    <main className="home-shell">
      <section aria-labelledby="product-name" className="status-panel">
        <p className="eyebrow">正式网站 · 任务 1</p>
        <h1 id="product-name">项目运营中心</h1>
        <p className="status-line">网站基础骨架已就绪</p>
        <p className="boundary-note">
          网站与未来手机 App 将通过版本化 HTTPS API 访问业务数据，不直接连接 PostgreSQL。
        </p>
      </section>
    </main>
  );
}
