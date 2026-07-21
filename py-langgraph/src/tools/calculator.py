from langchain_core.tools import tool
from pydantic import BaseModel, Field


class CalculatorInput(BaseModel):
    expression: str = Field(description="A math expression, e.g. '2 + 2' or '10 * 5'")


@tool(args_schema=CalculatorInput)
def calculator(expression: str) -> str:
    """Evaluate a math expression. Use this for calculations."""
    try:
        sanitized = "".join(c for c in expression if c in "0123456789+-*/().% ")
        result = eval(sanitized)
        return f"Result: {result}"
    except Exception:
        return f"Error: Cannot evaluate '{expression}'"
