export const metadata = {
  title: "Ludo Game",
  description: "Game backend & APIs",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
