declare module "*.css?raw" {
  const css: string;
  export default css;
}
declare module "*.css";

declare module "*?raw" {
  const text: string;
  export default text;
}
