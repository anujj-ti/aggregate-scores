import { createTheme } from "@mui/material/styles";

export const dashboardTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#60a5fa",
    },
    secondary: {
      main: "#34d399",
    },
    background: {
      default: "#0b1220",
      paper: "#111827",
    },
  },
  shape: {
    borderRadius: 10,
  },
  typography: {
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  },
});
