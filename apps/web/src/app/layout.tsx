import type { Metadata } from "next";
import Link from "next/link";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Aggregate Scores Dashboard",
  description: "Local operator dashboard for aggregate-score jobs",
};

type RootLayoutProps = {
  readonly children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <AppBar position="static" color="transparent" elevation={0}>
            <Toolbar>
              <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
                Aggregate Scores
              </Typography>
              <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
                <Button color="inherit">Dashboard</Button>
              </Link>
              <Link href="/architecture" style={{ textDecoration: "none", color: "inherit" }}>
                <Button color="inherit">Architecture</Button>
              </Link>
              <Link href="/jobs/new" style={{ textDecoration: "none", color: "inherit" }}>
                <Button color="inherit">Submit Job</Button>
              </Link>
            </Toolbar>
          </AppBar>
          <Container maxWidth="xl" sx={{ py: 3 }}>
            <Box>{children}</Box>
          </Container>
        </Providers>
      </body>
    </html>
  );
}
