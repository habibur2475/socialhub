import { AgeCalculatorTool } from '@/components/tools/age-calculator/age-calculator';

export const metadata = { title: 'Age calculator — SocialHub' };

export default function AgeCalculatorPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <AgeCalculatorTool />
    </div>
  );
}
