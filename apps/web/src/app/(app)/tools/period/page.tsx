import { PeriodTool } from '@/components/tools/period/period';

export const metadata = { title: 'পিরিয়ড ট্র্যাকার — SocialHub' };

export default function PeriodPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <PeriodTool />
    </div>
  );
}
