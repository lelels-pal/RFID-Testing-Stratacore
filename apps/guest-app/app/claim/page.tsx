import { redirect } from 'next/navigation';

interface ClaimPageProps {
  searchParams?: {
    token?: string;
  };
}

export default function ClaimPage({ searchParams }: ClaimPageProps) {
  const token = searchParams?.token;
  redirect(token ? `/guest?token=${encodeURIComponent(token)}` : '/');
}
