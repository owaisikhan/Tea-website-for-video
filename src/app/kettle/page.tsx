import type { Metadata } from "next";
import { KettleLab } from "@/components/kettle/KettleLab";

export const metadata: Metadata = {
  title: "The kettle · Kinari",
  description: "A glass teapot of tea, ray traced live in the browser with vgpu and WebGPU.",
};

export default function KettlePage() {
  return (
    <main>
      <KettleLab />
    </main>
  );
}
