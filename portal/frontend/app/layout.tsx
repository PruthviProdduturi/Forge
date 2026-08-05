import type { Metadata } from "next";
import "../styles/globals.css";
import { Providers } from "./providers";
import { ClientLayout } from "../components/ClientLayout";

export const metadata: Metadata = {
  title: "Forge",
  description: "The Core Platform",
  icons: {
    icon: "/icon.svg",
  },
};

// Inline script that runs synchronously before first paint to apply stored
// theme color and avoid FOUC (Flash Of Unstyled Color).
const themePreloadScript = `
(function() {
  try {
    var color = localStorage.getItem('forge-theme-color') || '#1e3a5f';

    // hexToRGB
    function hexToRGB(hex) {
      var c = hex.replace(/^#/, '');
      if (c.length === 3) c = c.split('').map(function(x){ return x+x; }).join('');
      var n = parseInt(c, 16);
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }

    // hexToHSL
    function hexToHSL(hex) {
      var rgb = hexToRGB(hex);
      var r = rgb.r/255, g = rgb.g/255, b = rgb.b/255;
      var max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
      var h=0, s=0, l=(max+min)/2;
      if (d !== 0) {
        s = d / (1 - Math.abs(2*l - 1));
        if (max===r) h = ((g-b)/d + (g<b?6:0))/6;
        else if (max===g) h = ((b-r)/d + 2)/6;
        else h = ((r-g)/d + 4)/6;
      }
      return { h: Math.round(h*360), s: Math.round(s*100), l: Math.round(l*100) };
    }

    // hslToHex
    function hslToHex(h, s, l) {
      var hn=h/360, sn=s/100, ln=l/100, r, g, b;
      if (sn===0) { r=g=b=ln; }
      else {
        function hue2rgb(p,q,t){ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; }
        var q=ln<0.5?ln*(1+sn):ln+sn-ln*sn, p=2*ln-q;
        r=hue2rgb(p,q,hn+1/3); g=hue2rgb(p,q,hn); b=hue2rgb(p,q,hn-1/3);
      }
      function toH(x){ var h=Math.round(x*255).toString(16); return h.length===1?'0'+h:h; }
      return '#'+toH(r)+toH(g)+toH(b);
    }

    var hsl = hexToHSL(color);
    var light   = hslToHex(hsl.h, hsl.s, Math.min(hsl.l + 20, 100));
    var lighter = hslToHex(hsl.h, hsl.s, Math.min(hsl.l + 40, 100));
    var dark    = hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 20, 0));

    function rgb(hex){ var c=hexToRGB(hex); return c.r+', '+c.g+', '+c.b; }

    var root = document.documentElement;
    root.style.setProperty('--forge-primary', color);
    root.style.setProperty('--forge-secondary', light);
    root.style.setProperty('--forge-accent', lighter);
    root.style.setProperty('--forge-dark', dark);
    root.style.setProperty('--forge-light', lighter);
    root.style.setProperty('--forge-primary-rgb', rgb(color));
    root.style.setProperty('--forge-secondary-rgb', rgb(light));
    root.style.setProperty('--forge-accent-rgb', rgb(lighter));
    root.style.setProperty('--forge-dark-rgb', rgb(dark));
    root.style.setProperty('--theme-primary', color);
    root.style.setProperty('--theme-light', lighter);
    root.style.setProperty('--theme-dark', dark);
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: themePreloadScript }}
        />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          <ClientLayout>{children}</ClientLayout>
        </Providers>
      </body>
    </html>
  );
}
