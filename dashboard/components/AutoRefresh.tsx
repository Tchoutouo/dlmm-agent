"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Rafraîchit les données serveur toutes les `seconds` secondes. */
export default function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
