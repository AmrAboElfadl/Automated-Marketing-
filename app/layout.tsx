export const metadata = {
  title: "Social Publisher",
  description: "Multi-platform content scheduler",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui", margin: 0, padding: 32 }}>
        {children}
      </body>
    </html>
  );
}
