import { useEffect } from "react";

/**
 * Landing page that immediately redirects to the standalone dashboard.html.
 * Includes SEO-friendly headings and keywords for crawlers before the redirect fires.
 */
export default function Home() {
  useEffect(() => {
    const timer = setTimeout(() => {
      window.location.href = "/dashboard.html";
    }, 80);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#f0f3f7",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
        color: "#2c3e50",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      {/* SEO headings — visible briefly before redirect */}
      <h1
        style={{
          fontSize: "1.6rem",
          fontWeight: 700,
          color: "#1a5276",
          marginBottom: "0.5rem",
        }}
      >
        日本の石油備蓄・ガソリン価格ダッシュボード
      </h1>
      <h2
        style={{
          fontSize: "1rem",
          fontWeight: 400,
          color: "#7f8c8d",
          marginBottom: "1.5rem",
        }}
      >
        資源エネルギー庁の公開データに基づく最新情報
      </h2>
      <p style={{ fontSize: "0.85rem", color: "#7f8c8d" }}>
        ダッシュボードを読み込んでいます...
      </p>
      {/* Hidden keyword-rich content for SEO */}
      <div style={{ display: "none" }}>
        <p>
          レギュラーガソリン全国平均小売価格、ハイオク価格、軽油価格、灯油価格の週次推移グラフ。
          国家備蓄・民間備蓄・産油国共同備蓄の日数と備蓄量を月次で可視化。
          資源エネルギー庁 石油製品価格調査および石油備蓄の現況データを使用。
          IEA基準90日以上の備蓄水準を確認できます。
        </p>
      </div>
    </div>
  );
}
