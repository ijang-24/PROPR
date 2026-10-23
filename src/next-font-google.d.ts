declare module "next/font/google" {
  export function Poppins(options: {
    subsets?: string[];
    weight: string | string[];
    variable?: string;
  }): {
    className: string;
    variable: string;
  };
}
